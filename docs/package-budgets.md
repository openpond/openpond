# Package and loading budgets

OpenPond intentionally distributes the CLI, local server, and browser app together.
Normal feature growth should not require changing a byte allowance in a PR.

## Hard checks

`scripts/distribution/package-policy.ts` defines stable distribution ceilings:

- 16 MiB compressed npm tarball.
- 64 MiB unpacked package.
- 1,000 package files, allowing code splitting while catching accidental trees.
- 32 MiB total renderer JavaScript.

These are broad safeguards with room above the September 2026 build (about 8 MiB
compressed, 26.5 MiB unpacked, and 16.2 MiB renderer JS). They are not measured
baselines to increase after every feature. Investigate a breach; change a ceiling
only for a deliberate change in the product's distribution requirements.

Initial HTML assets, the largest renderer asset, startup, and route response
budgets remain separate in `scripts/check-performance-budgets.ts`. The targeted
CI lane checks renderer budgets; full CI also probes the built server. CLI
installation and launch proofs still run in the distribution check.

Package content checks reject source maps, test/fixture payloads, source TypeScript
(except declarations), local videos, archives, and unexpected top-level files.
The production CLI build records emitted runtime files outside the npm package,
in `apps/cli/build/runtime-outputs.json`. Distribution checks compare that inventory
against the tarball to catch stale chunks and missing outputs. The staged browser
file list must also match the clean Vite build. Rebuild all CLI entrypoints before
checking a distribution; partial development bundles are not a release inventory.

## PR reports

CI saves a size snapshot from the current build and builds the exact PR base with
its frozen dependency lockfile. The current measurement script measures both
builds using the same Node/npm versions. The comparison is written to the
**Package size comparison** job summary and both JSON snapshots are retained as
workflow artifacts. This costs one additional base build per applicable PR;
there is no mutable, manually maintained baseline or cross-PR artifact dependency.
The current PR build is GitHub's tested merge commit, so its delta against the
base represents the prospective merged result.

The report includes exact npm tarball/unpacked sizes, renderer JS, HTML entry
assets, largest current files, and largest growth contributors. Content hashes
are normalized and runtime chunks grouped to avoid reporting split/rename churn
as new payload. Individual gzip sizes are diagnostic and do not add up to the
tarball size. HTML entry assets use the existing budget definition; this is not a
measurement of all transitively fetched browser code or a browser timing trace.

Growth warnings require both an absolute and proportional increase:

| Metric | Minimum increase | Minimum proportion |
| --- | ---: | ---: |
| Compressed package | 256 KiB | 5% |
| Unpacked package | 1 MiB | 5% |
| Renderer JavaScript | 512 KiB | 5% |
| HTML entry assets | 64 KiB | 10% |

Growth warnings do not fail CI. Failed measurements or hard checks do. Ordinary
small additions pass; the stable ceilings still bound cumulative growth.

## Local use

After building with `pnpm run build:artifacts && pnpm run cli:build:from-web`:

```sh
pnpm budgets:size --output artifacts/package-size.json --check-contents
pnpm budgets:size --head artifacts/package-size.json --base /path/to/base-size.json
pnpm budgets:check --renderer-only
pnpm cli:distribution:check
```

To measure an older checkout, use the current script with
`node scripts/report-package-size.ts --root /path/to/base --output artifacts/base-size.json --snapshot-only`.
The collector uses only Node built-ins and does not require the older checkout to
contain this tooling. Use clean builds and matching Node/npm versions for both
snapshots. Snapshots identify the checkout commit; local uncommitted changes can
also affect the measured output.
