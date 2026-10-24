# Existing training and continual workflows

Use `openpond-sdk` or its exact-version `ponder-sdk` distribution. The shared
operation inventory is `fixtures/python-foundation/operation-matrix.json`.
It records implemented client contracts, not deployed qualification. Hosted
capabilities currently advertise GRPO and reward-model training; recipe enums do
not establish SFT, DPO or per-gradient control. Always inspect capabilities for
the actual host/account before preparing work.

## Authentication and lifecycle

Training and Model clients accept `baseUrl`, `headers` (including an async token
supplier) and an injectable `fetch`. Use the host's normal Bearer credential and
`X-OpenPond-Team-Id`; retain server authorization and owner checks. Learning,
Dataset and taskset-run clients accept their existing `apiKey` and workspace
scope. Never put credentials in URLs, request identities, fixtures or receipts.

Learning, Dataset and taskset-run operations expose their existing AbortSignal
options. For the training/Model factories use an injected fetch with a caller's
AbortSignal and finite timeout, as the manual example shows. An abort ends a
local request; it does **not** cancel paid remote compute. Use the explicit
versioned cancel/stop-after-group/recovery operations and observe terminal
cleanup. Training GET failures have at most three attempts; writes are sent
once. Callers must not add blind write retries.

Persist operation IDs and immutable request bytes before a write. On a timeout
or lost response, reconcile the same preparation/operation and current revision;
do not mint another identity. A submitted preparation contains its durable job
ID. Use existing Dataset operation-result reads for uncertain authoring writes.
Expected revisions, plan hashes and model ETags remain required. The existing
estimate client currently lacks a hosted endpoint and is excluded from the runnable
base workflow; its schema does not establish availability. No estimate backend is
added here. A catalog read does not reserve capacity or increase spending approval.

Follow each page's `nextCursor` using the same scope/filter and supplied limits.
Do not treat a partial page or a transient request failure as an empty result.
Acceptance groups, evaluation task pages, candidate decisions and output hashes
retain their existing SDK identity checks. Candidate acceptance is distinct from
serving activation, which requires its existing explicit controls.

## Manual reviewed-batch workflow

1. Use the public Model, Dataset, Harness and Learning clients to select published
   immutable resources, review evidence and seal a batch. Keep the exact Model
   revision/ETag and batch revision/content hash. Private grader artifacts stay
   behind the host boundary.
2. Save a `TrainingPreparationRequest` JSON with a stable operation ID, exact
   configuration/batch references and approved maximum spend. Run
   `npx tsx examples/training/manual.ts prepare request.json prepared.json`.
   This creates a retained preparation and launches no training job.
3. Review the returned source and approved limits. Explicitly run
   `npx tsx examples/training/manual.ts start prepared.json submitted.json`.
   The example reads and retains a fresh GPU catalog, then submits the current
   preparation revision with its original reviewed maximum spend. Server admission
   owns current price, funding and capacity; the catalog is not a signed price lock.
   This step may incur the approved compute.
4. Reconnect with `status` using the same submitted/prepared receipt. Use `results`
   after terminal completion, then public evaluation/acceptance reads and the
   explicit `recordCandidateDecision` with its exact artifact reference and CAS.
   `cancel` reconciles the current job version before sending remote cancellation.

The examples require `OPENPOND_API_URL`, `OPENPOND_API_KEY` and
`OPENPOND_TEAM_ID` from the caller's normal configured account. They use only
public SDK imports, bound each invocation to two minutes and write new receipt
files exclusively with mode0600. They do not poll indefinitely or automatically
retry an uncertain paid start. Keep the original receipt for future reconciliation.
Use a supported reward-model configuration through the same preparation path
only when the host advertises that job kind and its input contracts are satisfied.

## Continual evidence, review and policy workflow

The public `OpenPondLearningClient` exposes typed `command`, `get`, `list`,
`inspectEvidence`, `inspectPolicy`, `inspectTaskQueue`, `publishBatch` and source
credential operations. Existing command schemas cover source/definition/Reward
publication, evidence and feedback, grade/review decisions, batch sealing and
iteration reserve/cancel/retry. Reuse released resources and exact revision refs;
the SDK does not execute Python-authored graders or invent another scheduler.

`npx tsx examples/training/continual.ts inspect policy-ref.json inspection.json`
reads current admission/budget without reserving an iteration. To execute one
reviewed existing command, use `command command.json response.json`. The input
must contain its stable operation ID and all schema-required scope-independent
release references, expected revisions and limits. A reserve command is an
explicit action, not a side effect of inspection. Retain the resulting iteration
and job references, observe them through the same public reads, and use existing
cancel/retry controls for recovery. Neither example changes recurring policy
settings merely by opening or inspecting them.

## Proof and release

Existing protocol fixtures are shared with Python, including canonical JSON and
content identities. The generator records unrepresentable schema/refinement gaps
instead of silently weakening them. Clean packed consumers, wrong-team/stale-CAS,
lost-reply reconciliation, pagination and real cancellation/recovery remain
integration gates. Examples and source/package checks do not establish a real
GPU result. Actual hosted GRPO/reward-model execution uses a separately bounded
approved workflow and retains exact version/SHA/input/result/cleanup evidence.
No package has been published by these changes.
