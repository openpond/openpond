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
