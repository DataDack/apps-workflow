// The serverless entry point for a managed app.
//
// It runs in one of two modes, decided by what the build packed beside it.
//
// SERVER mode (`index.mjs` present, an OpenNext bundle). OpenNext's aws-lambda
// wrapper produces a handler that renders pages but does NOT serve static
// assets: on AWS those live in S3 behind CloudFront and the server function
// never sees a request for one. Self-hosted there is no such CDN, so every
// `/_next/static/...` request would arrive here and 404 — the app would render
// unstyled, with no client bundle. This answers those from `assets/` and
// delegates everything else to OpenNext untouched.
//
// STATIC mode (no `index.mjs`, a react/SPA build). There is no server to
// delegate to, so the same asset serving IS the whole app, with the try-files
// behaviour a single-page app needs: an unmatched path falls back to
// `index.html` so client-side routing works on a hard refresh. This is what the
// Caddy container did, expressed as a handler.
//
// The mode is inferred rather than configured. A build either produced a server
// or it did not, and a flag saying otherwise would just be a second thing that
// can disagree with the bundle.
//
// The wrapper is always the handler the platform invokes
// (`datadack-handler.handler`); OpenNext's own `index.mjs` keeps its name, so
// neither file has to know about the other beyond the import below.

import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSET_ROOT = path.join(here, "assets");

// Loaded lazily so a failure to import the server bundle surfaces on the first
// request that actually needs it, rather than making every asset request fail
// too. An app whose server is broken but whose assets still serve is easier to
// diagnose than one that returns nothing at all.
let serverHandler;
let serverMode;

// hasServer decides the mode once, by asking the filesystem rather than trusting
// configuration. Cached because it is consulted on every request that misses an
// asset, which in static mode is every page view.
async function hasServer() {
  if (serverMode === undefined) {
    serverMode = await fs
      .access(path.join(here, "index.mjs"))
      .then(() => true)
      .catch(() => false);
  }
  return serverMode;
}

async function server() {
  if (!serverHandler) {
    const mod = await import("./index.mjs");
    serverHandler = mod.handler ?? mod.default?.handler ?? mod.default;
    if (typeof serverHandler !== "function") {
      throw new Error("the OpenNext bundle exported no handler");
    }
  }
  return serverHandler;
}

// Content types for what a Next.js build actually emits. Deliberately a small
// explicit table rather than a dependency: this file has to run with nothing
// installed beside it.
const CONTENT_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".zip": "application/zip",
};

// Anything not known to be text is returned base64-encoded. Guessing wrong in
// this direction corrupts a font or an image silently, so the default is the
// safe one.
const TEXTUAL = /^(text\/|application\/(json|xml|javascript)|image\/svg)/;

function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

// Hashed build output is immutable and may be cached forever. Everything else
// came from the repository's `public/` directory, where a file can be replaced
// without its name changing, so it gets a short cache and a revalidation.
function cacheControlFor(urlPath) {
  return urlPath.startsWith("/_next/static/")
    ? "public, max-age=31536000, immutable"
    : "public, max-age=0, must-revalidate";
}

// resolveAsset maps a request path to a file inside ASSET_ROOT, or null.
//
// The containment check is the security boundary: a request path is attacker
// controlled, and `/../../etc/passwd` resolved naively would read outside the
// bundle. Resolving first and then verifying the result is still under the root
// is what makes that impossible, rather than trying to spot bad input.
async function resolveAsset(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding is not an asset
  }
  if (decoded.includes("\0")) return null;

  const candidate = path.resolve(ASSET_ROOT, "." + path.posix.normalize(decoded));
  if (candidate !== ASSET_ROOT && !candidate.startsWith(ASSET_ROOT + path.sep)) {
    return null;
  }
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return null;
    return { file: candidate, size: stat.size };
  } catch {
    return null;
  }
}

async function readAsset(file) {
  const chunks = [];
  for await (const chunk of createReadStream(file)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// serveAsset renders one resolved file as an API Gateway v2 response.
async function serveAsset(asset, urlPath, method, cacheControl) {
  const contentType = contentTypeFor(asset.file);
  const headers = {
    "content-type": contentType,
    "content-length": String(asset.size),
    "cache-control": cacheControl ?? cacheControlFor(urlPath),
  };
  if (method === "HEAD") {
    return { statusCode: 200, headers, body: "", isBase64Encoded: false };
  }
  const bytes = await readAsset(asset.file);
  const textual = TEXTUAL.test(contentType);
  return {
    statusCode: 200,
    headers,
    body: textual ? bytes.toString("utf8") : bytes.toString("base64"),
    isBase64Encoded: !textual,
  };
}

// staticFallback is the try-files behaviour a single-page app needs: a directory
// serves its index.html, and anything still unmatched falls back to the root
// index.html so a hard refresh of a client-side route renders the app instead of
// a 404.
//
// The fallback is served with 200 rather than 404 deliberately — the route is
// real, it is simply resolved in the browser — and always revalidated, because
// index.html names the hashed bundles and a cached copy would pin a visitor to a
// previous deploy.
async function staticFallback(urlPath, method) {
  const directoryIndex = await resolveAsset(
    urlPath.endsWith("/") ? urlPath + "index.html" : urlPath + "/index.html",
  );
  if (directoryIndex) {
    return serveAsset(directoryIndex, urlPath, method, "public, max-age=0, must-revalidate");
  }

  const root = await resolveAsset("/index.html");
  if (root) {
    return serveAsset(root, "/index.html", method, "public, max-age=0, must-revalidate");
  }

  return {
    statusCode: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: "Not Found",
    isBase64Encoded: false,
  };
}

export async function handler(event, context) {
  const method = event?.requestContext?.http?.method ?? event?.httpMethod ?? "GET";
  const urlPath = event?.rawPath ?? event?.requestContext?.http?.path ?? "/";

  // Only ever intercept safe, body-less reads. A POST to a path that happens to
  // collide with an asset name belongs to the application, and answering it
  // here would silently swallow a form submission.
  if (method !== "GET" && method !== "HEAD") {
    if (await hasServer()) {
      return (await server())(event, context);
    }
    // Static mode has nothing that could handle a write, and saying so is more
    // useful than a 404 that reads like the route does not exist.
    return {
      statusCode: 405,
      headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
      body: "Method Not Allowed",
      isBase64Encoded: false,
    };
  }

  const asset = await resolveAsset(urlPath);
  if (asset) {
    return serveAsset(asset, urlPath, method);
  }
  if (await hasServer()) {
    return (await server())(event, context);
  }
  return staticFallback(urlPath, method);
}

export default { handler };
