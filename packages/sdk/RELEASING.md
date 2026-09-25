# Releasing sdk

Run `pnpm release:sdk:patch` (or `minor` / `major`) from clean, current master.
Use `--dry-run` to preview. Merge the generated PR after CI passes.



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
