# Test and CI reduction — 2026-09-25

Status: implemented on PR #437 with the account API-key access UI changes; local verification and remote CI evidence below. Remote timings and merge details are pending.

## Changes

- Remove nine redundant test files, fixed prose/markup/icon/registry inventories, trivial SDK getter tests, duplicated pilot fixtures, and Agent SDK documentation phrase enforcement. Move provenance and generated portable-version assertions into existing materialization and packed-consumer boundaries.
- Reduce the four CLI matrices from 46 process call sites to 9 while exercising real parsers, dispatch, and HTTP requests in process. Keep real stdin/secret rejection, cwd/upload, and packed installation proofs. Put their remaining process suites in integration.
- Reduce Agent SDK example commands from 45 to 15, and independent npm installs from eight to three. All templates and pilots still build/validate; the dependency-rich shapes and the public export/standalone bundle fixture keep full consumer checks.
- Share the voice binary/model streaming implementation before removing duplicate cleanup tests. Keep bounds, abort, private file permissions, incomplete-file rejection, and both entrypoints.
- Remove the PR base rebuild for size comparison; retain current package contents and absolute budgets. Move installed JSONL/cwd assertions into the real packed CLI consumer and remove the extra release-smoke job.
- Separate shipped build checks from npm installation checks. UI/runtime changes still build; package manifests, dependencies, export/entrypoint tooling, Evals/Harness sources, and master still receive installation proof. npm audit remains on master/local distribution runs instead of every PR.
- Keep desktop renderer smoke for web changes; package only for desktop/build/native/dependency/workflow inputs or manual runs. Run all storage cases on Linux, OS-sensitive custody/locking/recovery/rename cases on macOS/Windows, and the full matrix on manual dispatch. Remove duplicate workspace typechecks from portability.
- Make coverage observability manual and build its runtime prerequisites. Move million-event and append-latency checks into explicit performance runs while keeping small projection correctness tests in units. Enforce the CLI startup budget only in that performance run; ordinary tests retain protocol correctness and a timeout.
- Add semantic version-only package CI for Evals, Harness, SDK, and Agent SDK. Only an increasing stable version with all other fields unchanged qualifies. Master additionally requires the exact previous SHA's latest successful `ci.yml` push run and `Checks` job. The new SHA still gets its own package check and gate before trusted publication.
- Share four release-preparation helpers and the trusted CI publication gate; retain workflow identities, OIDC, registry verification, and package tags. Fix Harness's obsolete dependency allowlist to permit its current YAML parser.

## Conservative decisions

Changed lockfiles take full CI. There is no speculative semantic lockfile shortcut or extra dependency installation in the scope job. Pure workspace version bumps leave the lockfile unchanged. The proposed optional lockfile exception is deliberately stricter here.

Hosted-tool fallback and stored-data migration coverage remain: their production paths still exist, and the review made deletion conditional on paired production retirement and a current-format audit. Removing their tests alone would hide supported behavior. Existing permission, consent, lease, tenant, lifecycle, and persistence checks remain.

## Measurements

Elapsed time includes command startup. Local measurements are not directly comparable to GitHub runner times. Broad local validation overlapped independent checks, so it is evidence of completion, not an isolated performance benchmark.

| Measurement | Before | After | Evidence |
| --- | ---: | ---: | --- |
| Three CLI matrices, same machine and `--maxWorkers=2`, 16 tests | 13.65 s | 3.77 s | 72.4% lower elapsed time; logs `/tmp/openpond-cli-before.log` and `/tmp/openpond-cli-final.log` |
| Agent SDK example subprocess count | 45 | 15 | One full dependency-rich pipeline plus four build/validate pairs |
| Agent SDK independent npm installs | 8 | 3 | Generic export consumer, initialized rich template, rich copied pilot |
| Historical full PR CI | 5m46s | pending | [Before run](https://github.com/openpond/openpond/actions/runs/36096491382), 1,143 aggregate job-seconds |
| Historical full master CI | 4m05s | pending | [Before run](https://github.com/openpond/openpond/actions/runs/36096905675), 1,021 aggregate job-seconds |
| Historical PR base-size comparison job | 160 s | removed | Its base build consumed 135 s and extended the sampled critical path by 83 s |
| Local unit validation | not measured | 78.41 s | 188 files; 868 passed, one existing skip, before the final process-tier move |
| Local integration validation | not measured | 32.74 s | Five files, 29 tests passed after the tier move |
| Local CLI build | not measured | 94.23 s | Combined account and CI branch, overlapped validation |
| Local packed distribution | not measured | 73.02 s | API consumer, JSONL/cwd, local/global/npx/dlx, PTY, persistence all passed |

## Validation and rollout

- Passed: root and CLI typecheck; Harness, Evals and SDK package checks; Agent SDK typecheck/tests/examples/packed-install/hygiene/dry-pack components; focused release classifier and trusted-proof tests; real historical GitHub proof accepted.
- Passed: all four release-helper dry runs in a clean temporary master fixture; no Git or manifest mutation.
- Passed: eight executable aggregate-gate scenarios (targeted/full/package successes and failed/skipped/extra-job/scope rejection); workflow SHA checks and actionlint; repository structure/reachability/dependency checks; test-tier and hygiene checks.
- System run: 178 files passed; one CLI startup timing assertion failed (11.22s against 10s while builds ran). Protocol assertions passed. After moving that timing budget to the explicit performance lane, the focused CLI test passed in 4.19s. Full run elapsed 353.00s under concurrent local load.
- The retained app-server consumer typecheck exposed stale training fixtures: missing schema defaults and an invalid runtime event status. Fixtures now use the real Session schema defaults and `started` event status.
- Explicit performance lane passed: two files, three tests, 3.54s. Small projection correctness tests remain in the unit lane.
- Initial remote portability run exposed missing compiled contracts after removing the full workspace typecheck. Replaced it with `tsc -b apps/server`, which builds the storage test runtime without typechecking the renderer/desktop/terminal.
- Four real temporary Git repositories/diffs also accepted single version-only changes and rejected an extra source commit in the aggregate diff. File-mode changes are rejected.
- Final PR checks, merge SHA, and version-only release timing are recorded below when complete.
