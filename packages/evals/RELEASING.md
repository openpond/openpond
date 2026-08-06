# Releasing `@openpond/evals`

`@openpond/evals` is the public evaluation package for OpenPond Harnesses. It
depends on `@openpond/harness` and also re-exports Harness contracts to preserve
the existing root and Harness subpath API.

Version `0.3.1` is the first split-package release. Publish
`@openpond/harness@0.1.0` before publishing this version so npm can satisfy the
required Harness peer.

```bash
pnpm evals:check
pnpm release:evals:patch
# or release:evals:minor / release:evals:major
```

Merging a later release PR triggers `release-evals.yml`, trusted npm
publishing, registry verification, provenance verification, and the
package-specific tag. The prepared `0.3.1` release may be dispatched manually
after the first Harness publication.
