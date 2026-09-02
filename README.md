# DataDack workflows

This repository owns the reusable GitHub Actions workflow used to build DataDack managed applications. Customer repositories contain only a stable caller; build behavior can therefore be updated here without modifying customer source.

The workflow is secretless. It authenticates to DataDack with GitHub Actions OIDC, and the backend binds the token to both the customer repository and this reusable workflow.

## What is deliberately NOT here

**This repository is public**, and it has to be: a reusable workflow called from a
customer's own repository must be readable by it. So nothing here should be
anything but the build's orchestration.

The platform's serverless runtime wrapper — `datadack-handler.mjs`, the entry
point a build packs beside an app's output — used to live here and no longer
does. It is three hundred lines of asset path resolution, traversal guarding and
SPA fallback rules, and publishing it served no one. The build now fetches it
from the DataDack API over its own OIDC token (`runtime_url` in the claim
response), and verifies it against the digest that response carries.

It lives in the `serverless` repository, under `apps/managedapps/runner/runtime/`,
embedded in the control-plane binary — so the wrapper is versioned with the fleet
that invokes it instead of floating on `@main` here.

Anything else that needs to reach a build should reach it the same way: through
the claim response, not through this repository.
