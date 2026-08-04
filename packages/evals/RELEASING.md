# Releasing `@openpond/evals`

The package version is independent from OpenPond application and schema
versions. Version `0.1.0` supports these initial schema literals:

- `openpond.agentSnapshot.v1`
- `openpond.harnessRelease.v1`
- `openpond.tasksetRelease.v1`
- `openpond.runManifest.v1`
- `openpond.attemptReceipt.v1`
- `openpond.harnessTrace.v1`
- `openpond.graderEvidence.v1`
- `openpond.evaluationResult.v1`

## One-time npm bootstrap

Trusted publishing can only be configured after the scoped package exists. Once
this feature is merged, use a clean current `master` checkout:

```bash
pnpm evals:check
npm login
npm publish ./packages/evals --access public --ignore-scripts --provenance=false
npm install --global npm@^11.15.0
npm trust github @openpond/evals \
  --repo openpond/openpond \
  --file release-evals.yml \
  --environment npm-production \
  --allow-publish
npm trust list @openpond/evals
gh workflow run release-evals.yml --ref master
```

The last command is idempotent recovery: because `0.1.0` is already on npm, the
workflow skips publication and creates the missing `evals-v0.1.0` GitHub release.

## Later releases

From a clean current `master` checkout:

```bash
pnpm release:evals:patch
# or release:evals:minor / release:evals:major
```

The release helper creates an Evals-only release PR. Merging it triggers trusted
publishing with provenance, registry verification, and a package-specific tag.
Record the registry integrity/provenance evidence and merge commit in the
release notes after publication.
