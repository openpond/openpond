# CLI release workflow

The `openpond` CLI is independently versioned and published. SDK, Evals and Harness retain their own package release commands. CLI releases build the embedded server, renderer, declarations and local assets, then verify the actual packed install, aliases, app-server, TUI/PTY, ephemeral launches and persistence. They do not allocate Desktop platform jobs.

## Prepare a CLI release

1. From clean `master` matching `origin/master`, run `pnpm release:cli:patch`, `pnpm release:cli:minor` or `pnpm release:cli:major`.
2. The command changes only the CLI manifest version, refreshes the lockfile, runs `cli:check`, pushes `feat/release-cli-vX.Y.Z`, and opens a release PR. It does not change Desktop/server versions, push `master` or create a tag locally.
3. Merge after required CI passes. A strictly verified CLI version-only change uses package-only CI; a dependency, source or uncertain lockfile change retains ordinary source checks. Master additionally requires a successful exact parent proof before selecting package-only CI.
4. `release-builds.yml` selects CLI from the manifest version change and waits for `Checks` on the exact merged commit. It builds the complete CLI package and runs the packed distribution proof before npm trusted publication.
5. The workflow verifies registry installation and provenance before creating `cli-vX.Y.Z`. CLI releases do not replace the latest Desktop release, publish APT artifacts or run Mac/Linux Desktop packaging.

Do not combine CLI and Desktop version bumps in one release PR. That ambiguity is refused instead of silently dropping an artifact.

## Recovery and trusted publishing

`pnpm release:cli:stable` dispatches `release-builds.yml` with `target=cli`, `channel=stable` and the checked-in CLI version. It requires clean, current `master` and does not rewrite Desktop/server versions. `--dry-run` prints the intended dispatch. Recover an existing failed workflow before starting a duplicate; if publication was accepted but is not visible, wait for registry availability rather than bumping or republishing.

The publisher serializes CLI publication across push and manual triggers, then rechecks npm latest under the lock before any new publication to refuse downgrades. Recovering an exact existing older version leaves npm latest unchanged. Recovery verifies the exact packed artifact integrity and signed provenance for the release SHA, master branch and workflow before creating or confirming the CLI tag. An existing tag must resolve to that same commit; reruns recover an already-created GitHub release after a lost acknowledgement. Stable dispatches require master. The publisher recognizes an already-visible version and verifies it without overwriting it. Keep the existing npm trusted-publisher configuration bound to this repository, `release-builds.yml` and `npm-production`; no new token or workflow identity is required.

## Desktop releases

`pnpm release:patch`, `release:minor`, `release:major` and `release:stable` remain Desktop commands. They manage the Desktop/server cohort and platform integrity, signatures, packaged smoke, GitHub `vX.Y.Z` release and APT publication. They do not change or publish the independent CLI version. Nightly releases remain Desktop-only.
