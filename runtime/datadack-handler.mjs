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

// Directories whose contents every supported framework content-addresses.
//
// Each of these is a build output directory where the bundler writes the hash
// into the filename, so a changed file is a changed URL and the old one can be
// cached forever.
const IMMUTABLE_PREFIXES = [
  "/_next/static/", // Next.js
  "/_astro/", // Astro
  "/_nuxt/", // Nuxt
  "/_app/immutable/", // SvelteKit
  "/assets/", // Vite, and everything built on it — React, Vue, Preact, Lit, Solid, Qwik
  "/static/js/", // Create React App
  "/static/css/",
  "/static/media/",
];

// A content hash in the filename: a run of hex or base36 long enough not to be
// a word, sitting between separators before the extension.
//
// This is the general answer and the prefix list above is the fast path. Gatsby
// writes `webpack-runtime-dea6a3a642bdafc92770.js` at the ROOT, Angular writes
// `main-A7B2C9D1.js`, Docusaurus writes `runtime~main.abc12345.js` — none of
// them under a directory this could enumerate. Eight characters is the shortest
// hash any of these bundlers emits; below that the risk of matching a real word
// outweighs the benefit.
const HASHED_SEGMENT = /[.\-~]([0-9a-zA-Z]{8,})\.[a-z0-9]+$/;

// A segment is a hash if it is all hexadecimal, or mixed-case with a digit.
//
// The two-rule test exists to keep ORDINARY filenames out. `analytics2024.js`
// is eight-plus characters and contains a digit, and a looser rule would cache
// it for a year — so an update to a hand-written file in `public/` would never
// reach a returning visitor. That failure is silent and lasts a year, which is
// why this errs toward missing a hash rather than inventing one: a missed hash
// costs one conditional request, an invented one costs a stuck deploy.
function looksHashed(segment) {
  const hasDigit = /[0-9]/.test(segment);
  if (!hasDigit) return false;
  if (/^[0-9a-fA-F]+$/.test(segment)) return true; // webpack, Angular, Docusaurus
  return /[a-z]/.test(segment) && /[A-Z]/.test(segment); // Vite's base36
}

// How long a file that is NOT content-addressed may be held.
//
// Sixty seconds, not zero. `max-age=0` was the previous value for everything
// outside /_next/static/, and combined with no validator it meant a browser
// re-downloaded every file on every navigation — the whole bundle, in full, on
// a repeat visit. A minute plus a validator turns that into one conditional
// request that answers 304.
const MUTABLE_MAX_AGE = 60;

// Hashed build output is immutable and may be cached forever. Everything else
// came from the repository's `public/` directory, where a file can be replaced
// without its name changing, so it gets a short cache and a revalidation.
//
// HTML is never in the first group, whatever its name looks like: a document
// held by a browser is a deploy that never arrives.
function cacheControlFor(urlPath) {
  if (urlPath.endsWith(".html") || urlPath.endsWith("/")) {
    return "public, max-age=0, must-revalidate";
  }
  const immutable =
    IMMUTABLE_PREFIXES.some((prefix) => urlPath.startsWith(prefix)) ||
    looksHashed(HASHED_SEGMENT.exec(urlPath)?.[1] ?? "");
  return immutable
    ? "public, max-age=31536000, immutable"
    : `public, max-age=${MUTABLE_MAX_AGE}, must-revalidate`;
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
    return { file: candidate, size: stat.size, mtimeMs: stat.mtimeMs };
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
// A validator, so a cached copy can be revalidated instead of re-downloaded.
//
// Size and mtime rather than a content hash: the file is on disk and hashing it
// would mean reading every byte of every asset on every request, which is the
// cost this function exists to avoid. Both change whenever a build replaces the
// file, and a build is the only thing that writes here — the bundle is
// immutable once deployed.
//
// Weak (`W/`) because it is not a byte-for-byte guarantee. That is honest and
// costs nothing: a browser uses a weak validator for exactly the conditional
// request this enables, and `Range` is the only thing it would rule out.
function etagFor(asset) {
  return `W/"${asset.size.toString(16)}-${Math.floor(asset.mtimeMs).toString(16)}"`;
}

// Which content types are worth compressing.
//
// Text compresses three to four times; images, fonts and archives are already
// compressed and running them through gzip again spends CPU to add bytes.
const COMPRESSIBLE = /^(text\/|application\/(json|xml|javascript|manifest)|image\/svg)/;

// Below this, the header overhead and the CPU are not repaid.
const MIN_COMPRESS_BYTES = 1024;

function encodingFor(acceptEncoding, contentType, size) {
  if (size < MIN_COMPRESS_BYTES || !COMPRESSIBLE.test(contentType)) return null;
  const accepted = (acceptEncoding ?? "").toLowerCase();
  // Brotli first: roughly 15% smaller than gzip on JavaScript, and every
  // browser that speaks it says so.
  if (accepted.includes("br")) return "br";
  if (accepted.includes("gzip")) return "gzip";
  return null;
}

async function compress(bytes, encoding) {
  const { brotliCompress, gzip, constants } = await import("node:zlib");
  const { promisify } = await import("node:util");
  if (encoding === "br") {
    // Quality 5, not the default 11. Level 11 is for build-time compression of
    // a file served a million times; this runs per request on a cold-startable
    // worker, and 5 gets most of the ratio for a fraction of the CPU.
    return promisify(brotliCompress)(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
    });
  }
  return promisify(gzip)(bytes, { level: 6 });
}

async function serveAsset(asset, urlPath, method, cacheControl, requestHeaders) {
  const contentType = contentTypeFor(asset.file);
  const etag = etagFor(asset);
  const headers = {
    "content-type": contentType,
    "content-length": String(asset.size),
    "cache-control": cacheControl ?? cacheControlFor(urlPath),
    etag,
    // Tells a shared cache that the body varies by encoding. Without it, a
    // cache can hand a brotli body to a client that cannot read it.
    vary: "Accept-Encoding",
  };

  // A conditional request that still matches costs a header and no body. This
  // is what turns a repeat visit from a full re-download into 304.
  const inm = requestHeaders?.["if-none-match"];
  if (inm && inm.split(",").some((candidate) => candidate.trim() === etag)) {
    delete headers["content-length"];
    return { statusCode: 304, headers, body: "", isBase64Encoded: false };
  }

  if (method === "HEAD") {
    return { statusCode: 200, headers, body: "", isBase64Encoded: false };
  }

  const bytes = await readAsset(asset.file);
  const encoding = encodingFor(
    requestHeaders?.["accept-encoding"],
    contentType,
    asset.size,
  );
  if (encoding) {
    const packed = await compress(bytes, encoding);
    // Only if it actually helped. Compression can grow an already-dense body,
    // and shipping a larger one to spend CPU is the wrong trade twice.
    if (packed.length < bytes.length) {
      headers["content-encoding"] = encoding;
      headers["content-length"] = String(packed.length);
      // Compressed bytes are not text, whatever the content type says.
      return {
        statusCode: 200,
        headers,
        body: packed.toString("base64"),
        isBase64Encoded: true,
      };
    }
  }

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
async function staticFallback(urlPath, method, requestHeaders) {
  const directoryIndex = await resolveAsset(
    urlPath.endsWith("/") ? urlPath + "index.html" : urlPath + "/index.html",
  );
  if (directoryIndex) {
    return serveAsset(directoryIndex, urlPath, method, "public, max-age=0, must-revalidate", requestHeaders);
  }

  const root = await resolveAsset("/index.html");
  if (root) {
    return serveAsset(root, "/index.html", method, "public, max-age=0, must-revalidate", requestHeaders);
  }

  return {
    statusCode: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: "Not Found",
    isBase64Encoded: false,
  };
}

function lowerKeys(headers) {
  if (!headers) return {};
  const out = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

export async function handler(event, context) {
  const method = event?.requestContext?.http?.method ?? event?.httpMethod ?? "GET";
  const urlPath = event?.rawPath ?? event?.requestContext?.http?.path ?? "/";
  // Lower-cased once here rather than probed for both casings at each use.
  // HTTP header names are case-insensitive and the two event shapes this
  // handler accepts do not agree on which casing they send.
  const requestHeaders = lowerKeys(event?.headers);

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
    return serveAsset(asset, urlPath, method, undefined, requestHeaders);
  }
  if (await hasServer()) {
    return (await server())(event, context);
  }
  return staticFallback(urlPath, method, requestHeaders);
}

export default { handler };
