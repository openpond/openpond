# Releasing `@openpond/harness`

The package version is independent from OpenPond application and schema
versions. Version `0.1.0` is the initial public Harness release and supports
these initial schema literals:

- `openpond.agentSnapshot.v2`
- `openpond.harnessRelease.v2`
- `openpond.harnessTrace.v1`

## Trusted publishing

The package is published through `release-harness.yml` using npm trusted
publishing. `@openpond/harness@0.1.0` was the initial release. Do not publish
from a local feature branch or bypass the workflow.

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

## Version-only CI

Release preparation is shared across Evals, Harness, SDK, and Agent SDK. A stable
version increase in exactly one package manifest selects package checks on the
PR. All other manifest fields must be semantically identical. On merge, the
previous master SHA must have a successful latest `ci.yml` push run and `Checks`
job; missing, failed, pending, or ambiguous proof selects full CI. Publication
still waits for the new SHA's `Checks`.

Lockfile changes conservatively use ordinary CI, as do dependency, source, export,
workflow, and combined package changes. Pure workspace version bumps normally
leave the lockfile unchanged. The helper reports the selected path before commit.
A dry run requires clean, current master and prints the commands without changing
Git or package versions. Existing trusted publishing, registry verification,
package tags, and retry behavior are unchanged.
