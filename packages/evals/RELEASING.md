# Releasing `@openpond/evals`

`@openpond/evals` is the public evaluation package for OpenPond Harnesses. It
depends on `@openpond/harness` for exact Harness identities but exposes only
evaluation APIs. Publish the matching Harness peer before Evals so npm can
satisfy the declared range.

```bash
pnpm evals:check
pnpm release:evals:patch
# or release:evals:minor / release:evals:major
```

Merging a release PR triggers `release-evals.yml`, trusted npm publishing,
registry verification, provenance verification, and the package-specific tag.
Release notes must call out removal or movement of a public subpath and use the
appropriate semver increment.

Version `0.4.0` removes the retired Harness root barrel and
`./harness-improvements` / `./harness-workspaces` compatibility subpaths.
Consumers must import those public contracts from `@openpond/harness`; this is
an intentional breaking package-boundary correction.
