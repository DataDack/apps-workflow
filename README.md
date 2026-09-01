# DataDack workflows

This repository owns the reusable GitHub Actions workflow used to build DataDack managed applications. Customer repositories contain only a stable caller; build behavior can therefore be updated here without modifying customer source.

The workflow is secretless. It authenticates to DataDack with GitHub Actions OIDC, and the backend binds the token to both the customer repository and this reusable workflow.
