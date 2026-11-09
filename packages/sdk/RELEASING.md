# Releasing sdk

Run `pnpm release:sdk:patch` (or `minor` / `major`) from clean, current master.
Use `--dry-run` to preview. Merge the generated PR after CI passes.

## Coordinating contract and dependency changes

Choose the increment from the public contract, rather than defaulting to patch.
For the next training-catalog release, the strict retail-only `hourlyUsd`
offering replaces the previous offering shape. Existing clients can reject the
new response, so use a pre-1.0 minor increment: SDK and Ponder `0.13.0` from
`0.12.26`. Release notes must describe the catalog migration and the
whole-allocation rate (including attached disk); never infer a rate from
provider costs or an unavailable price.

The accompanying Evals collection-budget correction accepts previously rejected
valid collections without changing task limits or package exports. Its proposed
increment is patch: `@openpond/evals@0.12.7` from `0.12.6`. Recheck these proposed
versions against the registry when executing the release; never reuse an
already published version.

1. Merge and qualify the complete reviewed source on master. From clean,
   current master run `pnpm release:evals:patch --dry-run`, then
   `pnpm release:evals:patch`. Merge its release PR after checks pass. Wait for
   registry integrity, provenance and the `evals-v0.12.7` release receipt.
2. Raise this package's Evals dependency minimum to `^0.12.7` in a reviewed
   dependency PR, update the lockfile, and require ordinary CI. Keeping
   `^0.12.6` permits an installed consumer to retain the old implementation.
3. From clean, current master run `pnpm release:sdk:minor --dry-run`, then
   `pnpm release:sdk:minor`. The helper also advances Ponder and its exact SDK
   dependency to `0.13.0`; do not independently version the alias. Merge the
   resulting PR after its checks pass. Wait for SDK publication before Ponder's
   dependency gate completes, and retain both package tags and registry receipts.
4. Run `pnpm sdk:publish:check` and `pnpm ponder-sdk:publish:check` against the
   actual registry dependencies, without the local-Evals override. Retain exact
   source SHA, resolved dependency versions, archive integrity and installed
   consumer results. Local archive proof alone does not establish publication.
5. Release affected CLI, Python and Desktop clients through their own reviewed
   release processes, then verify installed artifacts against the same catalog
   and estimate contracts before the corresponding production cutover. Staging
   acceptance can use an exact reviewed source build; registry publication is
   not a prerequisite for that source validation.

Changing a dependency floor, coordinating multiple manifests, or updating a
lockfile is not a single-package version-only release. Preserve ordinary CI and
the normal clean-master release process for those changes. Package publication
does not establish live training, serving, pricing-settlement or UI acceptance.



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
