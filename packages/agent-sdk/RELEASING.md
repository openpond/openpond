# Releasing `openpond-agent-sdk`

`openpond-agent-sdk` is the TypeScript framework that defines an OpenPond
Profile Agent: its actions, workflows, integrations, evaluation gates, and
source-edit policy. It is versioned independently of the OpenPond app.

## Trusted publishing

Releases run exclusively through `.github/workflows/release-agent-sdk.yml`.
The workflow requires the protected `Checks` run, publishes with npm trusted
publishing and provenance, verifies the installed package and attestation, and
creates the corresponding `agent-sdk-v<version>` GitHub release.

The initial `0.1.0` release requires npm to recognize the exact package name
`openpond-agent-sdk` and its GitHub trusted-publisher association for this
repository, workflow, and `npm-production` environment. Do not substitute a
local publish or a token-based bypass. Once the association is in place,
dispatch the release workflow from `master` to make the initial release.

To inspect an existing release:

```bash
pnpm agent-sdk:check
npm trust list openpond-agent-sdk
npm view openpond-agent-sdk version dist.integrity dist.attestations
```

## Later releases

Prepare a package-only release from current `master`:

```bash
pnpm release:agent-sdk:patch
# or release:agent-sdk:minor / release:agent-sdk:major
```

Merge the generated release PR after CI passes. The workflow publishes the
version and creates its release tag.
