# Models and shared learning delivery

Status: In progress. This record distinguishes implemented local behavior from
the remaining complete local/hosted product. Working plans remain local under
the repository's existing `docs/working-docs` exclusion.

## Current checkpoint — September 6, 2026

The Models workspace uses one model selector and seven page/scope routes.
Reusable Rewards and task formats publish immutable revisions. Direct JSON/JSONL
intake, SDK submissions, grading, example review, feedback resolution and batch
sealing use one portable domain service. Local SQLite stores historical releases,
operation receipts, family/split reservations and leased grading jobs.

Model configuration saves now use a public SDK request with explicit create/edit
revisions and stable operation identity. SQLite commits configuration and retry
receipts together, validates the attached Taskset's exact revision and Profile,
and preserves server-owned hosting records. Competing edits have one winner;
replaying a save returns its original receipt even after subsequent edits.

Rewards now have typed source controls, immutable stored code/rubric assets and
atomic source-plus-Reward publication. Local code grading uses the public
QuickJS interpreter in a cancellable worker; the older Taskset code adapter uses
that same execution boundary. Browser publication and exact source reopening,
authenticated HTTP grading with evaluator context, and clean-package worker
execution have been verified. Combined Rewards now publish reusable recipes with
exact source releases, roles, normalization, weights and gates. Task-format edits
copy those settings into independent bindings and retain recipe provenance. Each
format release owns its direct source; previous producers keep their contract.
Review shows the execution receipt's per-source raw/normalized scores and feedback.
LLM calibration/execution, learned-model execution and model creation remain open.

The browser journey published a Reward and task format, imported an incorrect
observed answer, graded a corrected target separately, approved the task and
target, sealed a batch, selected an existing model and reopened its saved run
setup. Browser Back/Keep editing retained an unsaved Reward editor. Review
proposals can be saved as pending feedback before leaving.

The combined-Reward browser journey publishes two sources, copies the recipe into
a task format, imports an example and executes both graders successfully. The
HTTP boundary test also proves the 3:1 weighted score stays 0.75 after editing the
reusable recipe, and forged recipe provenance cannot publish a partial binding.

Preparing a batch rechecks its exact historical evidence and review snapshots,
scans its content, creates a private Taskset projection and calculates actual
readiness. Training export preserves the approved supervised target and policy
context; expected answers and evaluator context remain separate. Preparation and
export do not constitute executed training or a quality improvement.

Public artifacts are prepared as `@openpond/evals@0.7.0` and
`openpond-sdk@0.1.0`. Packed clean consumers verify runtime exports, TypeScript
declarations, generated JSON Schema and SDK transport. The SDK release workflow
waits for its required Evals release to become installable. Publication itself
has not been verified at this checkpoint.

## Phases

### Phase 1 — Shared contracts and local UI

- [x] Define portable tasks, Rewards, evidence, review, batches and learning-policy contracts. Done: versioned schemas; exact references; bounded JSON validation; generated HTTP schemas.
- [x] Implement durable local operations and public transport. Done: SQLite transactions/history; idempotent commands; authenticated SDK/HTTP; leased grading and cancellation.
- [ ] Complete every Models destination, scope transition and resource editor.
- [ ] Complete Setup → Tasks → Reward creation, the first four qualified starters and reusable binding/source editors.

### Phase 2 — Complete local manual learning

- [x] Connect direct intake, independent output grading, review and sealed batches. Done: JSON/JSONL import; corrected-target grading; feedback revision/decision records; split isolation.
- [x] Prepare approved batches for an explicitly selected model. Done: immutable snapshot validation; real readiness; saved run setup; separate supervised target export.
- [ ] Complete mapped Work/benchmark/trace intake and bounded large-asset storage.
- [ ] Execute candidate training, retained evaluation, acceptance and serving through a supported destination.
- [ ] Complete all 28 qualified starter packages, personalization and advanced specialist flows.

### Phase 3 — Published packages and hosted parity

- [ ] Publish and verify the exact public packages from the registry.
- [ ] Implement scoped hosted persistence, source authentication, grading, review and package operations in Sandbox using those packages.
- [ ] Deliver equivalent hosted Models pages and prove the manual journey with Desktop closed.

### Phase 4 — Automatic continual learning

- [ ] Implement durable triggers, claims, watermarks, budgets, recovery and human-review waits.
- [ ] Execute candidate training and retention checks with independent parent, teacher and upstream-trigger references.
- [ ] Prove gated acceptance/promotion, rollback and the closed loop with Desktop closed.

## Validation

Representative checks use real SQLite and authenticated HTTP, covering retries,
conflicting writes, historical reads, rollback, held-out family/input isolation,
out-of-order corrections and authoritative cancellation. The preparation journey
checks actual readiness and approved-target export. Public Evals tests cover
schema validation and grader semantics; clean packed consumers exercise the
distribution boundary. Repository type, structure, reachability, dependency,
workflow and hygiene checks remain required.

The first PR checks exposed a Windows compiler-launch issue, missing test-tier
entries, eager learning initialization in isolated API tests, and a renderer size
overage. The compiler now runs through Node, boundary tests use the system tier,
initialization follows service use, and public Evals exports support tree shaking.
CI for `e30a4472` passes, including Windows/macOS/Linux storage, Desktop smoke,
unit/system tests, builds and CLI distribution. The later combined-Reward change
passes local typechecking and the authenticated grading test; its CI is pending.

The isolated browser profile has no configured training destination. No executed
candidate training, full starter qualification, hosted parity or automatic
learning result is claimed by these local checks.
