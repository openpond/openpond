# Releasing `@openpond/harness`

The package version is independent from OpenPond application and schema
versions. Version `0.1.0` is the initial public Harness release and supports
these initial schema literals:

- `openpond.agentSnapshot.v2`
- `openpond.harnessRelease.v2`
- `openpond.harnessTrace.v1`

## Trusted publishing

The package is published through `release-harness.yml` using npm trusted
publishing. `@openpond/harness@0.1.0` is the current initial release; do not
publish from a local feature branch or bypass the workflow.

To inspect an already-published version:

```bash
pnpm harness:check
npm trust list @openpond/harness
npm view @openpond/harness version dist.integrity dist.attestations
```

## Later releases

For releases that do not already carry an intentional version bump, merge
feature work without changing the package version. When the intended package
changes are on `master`, prepare a separate release from a clean current
`master` checkout:

```bash
pnpm release:harness:patch
# or release:harness:minor / release:harness:major
```

The release helper creates a Harness-only release PR and updates the package
version and lockfile. Merging it triggers trusted publishing with provenance,
registry verification, and a package-specific tag. Record the registry
integrity/provenance evidence and merge commit in the release notes after
publication.
