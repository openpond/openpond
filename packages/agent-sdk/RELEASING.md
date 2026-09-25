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
