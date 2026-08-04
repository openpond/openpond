# Releasing `@openpond/evals`

The package version is independent from OpenPond application and schema
versions. Version `0.1.1` is the current provenance-backed baseline and supports
these initial schema literals:

- `openpond.agentSnapshot.v1`
- `openpond.harnessRelease.v1`
- `openpond.tasksetRelease.v1`
- `openpond.runManifest.v1`
- `openpond.attemptReceipt.v1`
- `openpond.harnessTrace.v1`
- `openpond.graderEvidence.v1`
- `openpond.evaluationResult.v1`

This branch prepares the additive Work evidence schemas for `0.2.0`:

- `openpond.workEvidenceReceipt.v1`
- `openpond.workProcessTrace.v1`
- `openpond.workFeedbackReceipt.v1`
- `openpond.workEvidenceEligibility.v1`

## Trusted publishing

The package already exists on npm and the `npm-production` environment is
configured for trusted publishing through `release-evals.yml`. Do not run a
manual `npm publish` or repeat the original bootstrap. The workflow uses its own
pinned npm version for trusted publication and provenance.

To inspect an already-published version:

```bash
pnpm evals:check
npm trust list @openpond/evals
npm view @openpond/evals version dist.integrity dist.attestations
```

## Later releases

For releases that do not already carry an intentional version bump, merge
feature work without changing the package version. When the intended package
changes are on `master`, prepare a separate release from a clean current
`master` checkout:

```bash
pnpm release:evals:patch
# or release:evals:minor / release:evals:major
```

The release helper creates an Evals-only release PR and updates the package
version and lockfile. Merging it triggers trusted publishing with provenance,
registry verification, and a package-specific tag. Record the registry
integrity/provenance evidence and merge commit in the release notes after
publication.
