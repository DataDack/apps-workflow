# Composite actions

The reusable build workflow's steps, factored into files so a change to one
concern is a change to one file.

## Why they are referenced by full path

```yaml
uses: DataDack/workflows/.github/actions/resolve-shape@main   # correct
uses: ./.github/actions/resolve-shape                          # BREAKS
```

`build.yml` is a **reusable workflow**: the workspace holds the *customer's*
repository, because that is what gets checked out and built. A relative path
resolves against that tree, where these actions do not exist. The fully
qualified form fetches them from this repository independently of the
workspace.

## Why `@main` and not a pinned tag

The customer's caller already pins `build.yml@main`, and that is the whole point
of the arrangement — build behaviour improves centrally without a pull request
into every customer repository. Everything inside the workflow is meant to move
with it.

That is **not** the same as a floating third-party version. What must never
float is an input nobody here controls — `bun@1`, a base image major, a Go
toolchain — because it changes a customer's build with no change anywhere we can
see, and they cannot diagnose it. These actions are ours, and they move when we
move them.

## The actions

| Action | Owns |
|---|---|
| `resolve-shape` | Turning the catalogue's framework class into the one value the build branches on, and refusing a shape this runner cannot produce |
| `setup-toolchain` | The language runtime and the dependency cache |

## Adding a framework

Nothing here changes. A framework is a JSON file in the platform's catalogue
bucket, under `system_data/managedapps/frameworks/`; the control plane sends its
**class** on the claim, and `resolve-shape` maps that to a build shape. Adding
Astro or VitePress needs no change to this repository at all — which is the
property worth protecting, because customers cannot upgrade it on their own
schedule.

Adding a framework **class** — a genuinely new build shape — is a change to
`resolve-shape` and to the packaging step in `build.yml`.

## Adding a toolchain

`setup-toolchain` rejects anything but `node` today, by name rather than by
assumption. The six `dynamic` frameworks in the catalogue (Express, NestJS,
FastAPI, Flask, Django, Go) need Python and Go here before they can build;
`resolve-shape` refuses them until then, loudly, at the top of the job.

That refusal is deliberate. Building a static site from a server-rendered app
succeeds, deploys, and then 404s every route at request time — which reads as
the customer's bug, hours later, instead of ours in the first ten seconds.
