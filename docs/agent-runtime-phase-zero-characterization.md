# Agent Runtime Phase 0 Characterization

This ledger freezes the runtime behavior that the app-server extraction must
preserve. The machine-readable source is
`tests/fixtures/runtime-convergence/phase-0-characterization.json`; the root
unit suite verifies the Local fixture hashes and the required behavior families.

## Local baseline

The baseline is OpenPond merge commit
`f3381f75b6bb259c953b171a602a30a55876d9c2` (PR #69). Its executable fixtures
cover provider rounds, tool batches, request ordinals, compaction, interruption,
concurrency, approvals and user input projection, immutable Harness admission,
Skill and memory loading, Refine routing, candidate validation, advancement,
review, rollback, and release materialization.

The causal product gate is
`apps/server/src/harness/local-harness-refinement-acceptance.test.ts`. It runs
against a real temporary SQLite store and content-addressed Harness bundles. A
task admitted on release R1 takes a failing legacy converter path and recovers;
the bounded Refiner creates and advances R2; the R1 task remains pinned; and a
fresh task admits R2 and takes only the safe path. This is retained as a
first-class non-regression gate rather than replaced by a transport unit test.

Baseline verification on 2026-08-07 used Node 24.18.0:

- repository TypeScript project build passed;
- 373 of 374 root/CLI unit files passed (1,861 of 1,862 tests);
- the only failure was the known `local-image-tool-registry` ImageMagick
  dependency (`spawn identify ENOENT`) on this machine, the same environmental
  exception recorded in PR #69; CI installs ImageMagick.

## Hosted baseline

The hosted reference is Sandbox commit
`3559206a887c2c9bda1e944e1e965694917afe60`. Phase 0 does not change hosted
execution. The manifest pins the exact hosted provider-round implementation and
tests for runtime composition, local and managed tool adapters, event ordering,
web projection, Chat/Work turn lifecycle, cancellation, and outputs. These
fixtures are the comparison source for Phase 3, after Local Phases 1–2 pass.

## Canonical parity hashes

All parity hashes use SHA-256 over recursively key-sorted JSON encoded as UTF-8.
The manifest fixes the included fields for canonical events, tool results,
checkpoints, capabilities, and effective Harness surfaces. Runtime-generated
identifiers and wall-clock timestamps are excluded unless they are part of an
explicit causal reference. The extracted runtime package owns the
canonicalization implementation; hosts persist and compare the resulting
hashes.

## Change rule

Extraction may move a pinned Local fixture, but it must preserve its assertions
and update this ledger in the same milestone commit. A semantic expectation may
change only with an explicit product decision and new before/after evidence.
Hosted hashes must not be updated during Local-only Phases 1–2.
