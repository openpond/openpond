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
Expected revisions, plan hashes and model ETags remain required. Estimate availability and measured coverage depend on the configured host.
`estimate()` is a read-only POST for exact preparation, configuration or submission
inputs. It returns current GPU/disk rates and explicit unknowns when calibrated
cost or duration evidence is missing. A configuration estimate does not prepare a
batch. Carry a preparation estimate's `review` into `startPreparation`; admission
checks its exact input, actor, runtime, provider scope, expiry and reviewed rate.
It reserves neither money nor capacity and does not raise the approved cap.

Follow each page's `nextCursor` using the same scope/filter and supplied limits.
Do not treat a partial page or a transient request failure as an empty result.
Acceptance groups, evaluation task pages, candidate decisions and output hashes
retain their existing SDK identity checks. Candidate acceptance is distinct from
serving activation, which requires its existing explicit controls.

## Standalone experiment drafts

The draft client surface stores creator-owned authoring documents independently
of chats, model configurations and training Jobs. Host deployment of the draft
routes is required. Saving does not validate execution availability, reserve
credits, stage data or start compute.

Evaluation authoring uses `evaluationForm` for its editable settings, exact
Dataset/task selection, released graders and mappings, optional source run, and
execution location. Training authoring uses `trainingForm`. Cleared evaluation
numeric controls remain `null`; blank training spend fields remain strings.
These incomplete values can be retained without becoming executable requests.

Model setup authoring may also retain optional `modelSetup` metadata, exported
as `ModelSetupDraftSchema` and `ModelSetupDraft` from `openpond-sdk/training`.
It stores the selected workflow (`sft`, `rl`, `decision`), adapter (`lora`,
`engram`, `neuron-training`), `continualLearning` choice, current setup section
(`model`, `dataset`, `graders`, `learning` or `settings`)
and an optional editable Dataset `{ id, revision }`. That Dataset reference is
an authoring destination, not an admitted training batch or immutable release.
These choices survive the same revisioned draft save/read lifecycle. They do
not publish a learning policy or establish executor compatibility. Call
`assertModelSetupExecutionIntent(draft, requestedOperation)` when converting a
retained setup draft into a preparation request. It rejects a different or
unsupported workflow/adapter operation; executor admission still owns runtime,
permissions and resource checks. Direct explicit-method APIs remain independent
of this authoring metadata.

Use `training.saveExperimentDraft(request)` with
`schemaVersion: "openpond.experimentDraftSave.v1"`, `teamId`, a stable
`operationId`, `expectedRevision`, optional `projectId`, and an
`ExperimentDraftSchema` document. Revision zero creates a draft. A later save
uses the revision returned by `getExperimentDraft(teamId, id)`. Explicitly retry
the same operation/request after an uncertain response; its original receipt
remains unchanged after later edits. Changed inputs require a new operation ID.
Do not silently replace a newer draft after a revision conflict.

`listExperimentDrafts(teamId, filters)` supports Project, literal name search,
archive state and bounded cursor pagination. Cursors are scoped to the current
creator/workspace and filters. `archiveExperimentDraft(id, control)` retains
history and requires its own operation ID and expected revision. Saving an
archived document at its current revision explicitly restores it. Each read and
receipt verifies the retained document hash and requested scope.

Native Python exposes `save_experiment_draft`, `get_experiment_draft`,
`list_experiment_drafts` and `archive_experiment_draft` in both clients. The
corresponding official CLI commands are:

```sh
openpond training hosted-drafts --team-id TEAM --json
openpond training hosted-draft DRAFT --team-id TEAM --json
openpond training hosted-save-draft draft.json --team-id TEAM --json
openpond training hosted-archive-draft DRAFT --team-id TEAM --operation-id OPERATION --expected-revision 2 --json
```

A draft ID identifies an editable authoring record. An execution ID identifies
an immutable run; neither is a substitute for the other.

## Manual reviewed-batch workflow

### Credit coverage and Billing handoff

On hosts implementing these endpoints, `training.funding(request)` checks the
entire `maximumSpendUsd` against current included/prepaid usage and member limits.
Use `schemaVersion: "openpond.trainingFundingRequest.v1"`, `teamId`, the positive
cap and optionally an exact saved draft reference. Restricted viewers receive
coverage status without account balances. This observation expires quickly and
does not reserve credit or authorize a Job.

After saving the draft, `training.fundingHandoff(request)` accepts
`schemaVersion: "openpond.trainingFundingHandoffRequest.v1"`, `teamId`,
`maximumSpendUsd` and the required `draft: { id, revision, contentHash, projectId }`.
Changed revisions, caps or ownership are rejected. Current purchase permission
controls whether a grantless Billing URL is returned; normal Web sign-in remains
required. Native Python uses `client.training.funding(...)` and
`client.training.funding_handoff(...)` with the same inputs, in sync and async
clients. The CLI exposes `hosted-funding` and `hosted-funding-handoff`.

Keep the original experiment open while Billing is used separately. On return,
verify the saved draft, recheck settled credits and refresh the exact preparation
estimate before explicit Start. Pending payments and card setup add no spendable
credit; a completed purchase never starts training automatically. Hosted
deployment and complete financial/UI qualification remain pending.

### Authoring and preparation

`ExperimentDraftSchema` (from `openpond-sdk/training`) describes an incomplete
authoring snapshot with its own identity, an `evaluate`, `sft` or `grpo` type,
name and optional canonical training inputs/settings. Chat can retain this
snapshot before a dataset or chat session exists. The native Python schema
inventory includes the same draft shape. A draft is not a preparation or run;
its identity does not grant access to referenced models or inputs. Validate and
authorize the complete request through preparation before execution.

The optional `trainingForm` preserves editable model/recipe/input references,
validation split, name and spend text, including blank fields. It is distinct
from a valid submission: saving a blank spend field never supplies a spending
authorization. `TrainingExperimentFormDraftSchema` describes those values.
`ExperimentDraftUpdateSchema` binds a save operation to an expected draft
revision. Desktop chat uses that contract to reject stale saves and reconcile
retries; a draft save does not prepare or start training.

For model-first setup, `training.prepareExperiment(request)` accepts an exact
`baseModel`, method-specific `settings`, reviewed `batch`, name and spend cap.
Use `TrainingExperimentSetupRequestSchema` from `openpond-sdk/training`. The
service resolves the owned configuration internally and returns
`{ request, requestHash, preparation }`; no preliminary Model-creation call is
required. Native Python exposes the same operation as
`client.training.prepare_experiment(request)`, including its async counterpart.
Host deployment and normal method/data admission still determine availability.

An optional `parent` retains a trained GRPO starting checkpoint in both
`TrainingPreparationRequest` and model-first setup. Its shape is:

```ts
{ jobId, artifact: { id, contentHash }, checkpointId,
  adapterMode: "residual_append" /* or "shared" / "sequential_merge" */ }
```

Use references returned by the producing Job and its retained artifact/checkpoint
records. A Model name or inference alias cannot identify this source. The host
checks the creator/workspace, final checkpoint and published manifest before
preparing; funded execution still rechecks runtime, adapter composition and
method qualification. A listed mode is a contract value, not proof that the
current image admits it. Optimizer state resets for a new stage; interrupted
checkpoint recovery is a separate operation. SFT continuation is unavailable in
the current worker. Never silently replace an unavailable parent with base-only
training. Draft `trainingForm.parent` preserves these references across save and
reopen; `startingModelLabel` is display text and grants no execution authority.

The CLI equivalent is `openpond training hosted-prepare-experiment draft.json
--team-id <id> --json`. Retain the input and returned receipt. Preparation starts
no compute. Explicit `hosted-start` accepts either that wrapper receipt or a
normal preparation receipt, requires `--yes`, and uses the same funded start
boundary. Reusing an operation ID with different inputs is a conflict; editing
and rerunning uses a new operation ID.

Use `hosted-preparation <id>` to read one retained preparation and
`hosted-preparations --cursor <id>` to follow discovery pages (`--project-id` and
`--limit` are supported). `hosted-cancel-preparation <receipt.json>` cancels an
unsubmitted preparation with its reviewed plan hash and current revision. Both
ordinary and model-first wrapper receipts are accepted. Once a job exists, use
the job controls and keep its identity.

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

The TS example `examples/training/continual.ts` and native Python example
`python/openpond-sdk/examples/continual.py` expose the same explicit steps:

1. `inspect policy-ref.json inspection.json` checks the exact released policy.
   Use existing reviewed source/definition/reward/binding resources and approved
   evidence; `command command.json response.json` may publish/review/seal only
   the explicitly supplied typed command. These are writes, and grade/reward
   checks can incur model cost. They are never inferred from opening a policy.
2. `reserve reserve-command.json reserved.json` sends one existing
   `reserve_iteration` command with a stable operationId, pinned policy
   `{id, revision, contentHash}` and manual trigger `{kind:"manual", identity}`.
   This is the explicit paid-admission boundary: host workers may dispatch it
   automatically. The policy must already contain the reviewed configuration,
   batch/evidence eligibility and finite budget; the example never enables it,
   changes its limits or accepts/promotes a candidate automatically.
3. If the reply is lost, `reconcile reserve-command.json reconciled.json` reads
   that policy's chain and scans at most10 pages of100 reservations for the SAME
   pinned policy/manual trigger. It never issues another reservation. A missing
   result is UNKNOWN, not permission to submit a new operation/trigger.
4. `status reserved.json status.json` reloads the retained iteration, lists only
   its dispatch, refreshes the iteration once and checks policy/execution identity
   before reading its training job. Inconsistent snapshots require another read,
   never a mutation. Reinvoke explicitly
   with the latest receipt; there is no unbounded polling. `results status.json
   results.json` requires settled dispatch plus authoritative terminal cleanup
   receipt, then reads retained training outputs. Only cancellation before initial
   submission may return a terminal record without a job. A candidate_ready result is not
   accepted or served, and failed/cancelled terminal records are not success.
5. For `cancel` or `retry`, add a new stable `operationId` to a retained response.
   Each reloads current iteration revision; retry additionally requires the SAME
   blocked dispatch. The host handles cancellation by dispatch identity, including
   uncertain initial submission. Read status/results until authoritative terminal
   receipt is observed. Local request abort never claims remote cancellation.

Each invocation has a120-second bound, exclusive private output and retains exact
iteration/policy/dispatch/job references. Reservation reads cannot manufacture
proof of actual execution. This declares existing manual-trigger continual
iterations; schedule/approved-count automation and Python-authored graders are
not demonstrated by this example. One ordinary external consumer must still run
the reviewed hosted sequence after platform security qualification.

## Proof and release

Existing protocol fixtures are shared with Python, including canonical JSON and
content identities. The generator records unrepresentable schema/refinement gaps
instead of silently weakening them. Clean packed consumers, wrong-team/stale-CAS,
lost-reply reconciliation, pagination and real cancellation/recovery remain
integration gates. Examples and source/package checks do not establish a real
GPU result. Actual hosted GRPO/reward-model execution uses a separately bounded
approved workflow and retains exact version/SHA/input/result/cleanup evidence.
The original `openpond-sdk@0.12.8` is published and independently verified.
The source follow-up prepares coordinated SDK/Ponder0.12.9; it does not claim
that version is published. Ponder npm and Python first-name publication remain separate publisher/bootstrap
gates; clean packed consumers do not establish registry ownership.

Training history is available through `client.listExecutions(teamId, { projectId, datasetHash, search, cursor, limit })` (`GET /v1/training/executions`). It returns bounded typed collection metadata around canonical Job identities, without examples, input bundles or artifact payloads. Use the returned Job ID with existing lifecycle/results operations. Missing historical model/data pins remain null; the collection never fills them from current Model settings. Python exposes `training.list_executions` in both native clients, and the CLI exposes `training hosted-executions`. Availability still depends on the deployed hosted release.


### Hardware specifications and live offers

`training.hardwareCatalog()` reads persisted provider GPU specifications, their content version and refresh timestamps. Its runtime labels distinguish candidates requiring live workload checks from hardware that is not admitted. The catalog contains no prices or stock. `training.gpuCatalog()` reads current offers; canonical preparation and reviewed execution admission remain required. Neither a GPU listing nor its maximum per-Pod count proves free capacity or support for a larger model. Python clients expose the same metadata read as `client.training.hardware_catalog()`.


`training.gpuCatalog(query)` binds live offers to `teamId`, the exact model/tokenizer/template revisions, method, LoRA rank and GPU count. The response includes its request hash, opaque provider-account scope, product/cloud/geography/CUDA constraints and expiry. It labels provider catalog pricing separately from accepted execution pricing; no capacity or credits are reserved. Unsupported combinations return a reason with no offers. The SDK rejects expired or substituted scoped replies. Calling `gpuCatalog()` without a query remains an overview read. Python sync/async clients accept the same fields through `training.gpu_catalog(query=...)`; the CLI accepts a JSON query file. Preparation and signed cost/funding review still own execution admission.


Timing calibration is implemented in source, with hosted proof pending. A partial
estimate can use the observed median and minimum/maximum of at least three clean,
matching completed executions from the same actor/workspace. The response binds
its cohort hash into the signed input review, reports incomplete sample counts
and separately excludes clean matches from other observed runtime profiles. This is historical evidence, not a confidence interval, latency
guarantee or token-throughput extrapolation. Queue wait, exact unmeasured token
populations and uncovered resource costs remain unknown. No calibration job is
launched by an estimate request. A `gpu_allocation` component prices conserved
billable allocation time from at least three matching completed runs at the
current whole-Pod GPU-plus-disk rate. Weighted sharing and device count are
already included once; other GPU phase rows do not add separate charges. The
component's expected cost and observed-range repricing are partial evidence.
Whole-run totals remain null while CPU, judges, network or retention lack
complete coverage; a spending ceiling is never substituted for an estimate.

## Copy a published Dataset into review

The Dataset review path and shared Dataset import UI are implemented in source;
hosted import/review qualification is still pending. They reuse the workspace
learning review engine without requiring a saved Model. Obtain the exact package through
`OpenPondTasksetPackageClient.getByRelease()` before composing this request:

```ts
const receipt = await training.reviewDataset({
  schemaVersion: "openpond.datasetTrainingReviewRequest.v1",
  teamId,
  operationId: "review-selected-examples-1", // retain on uncertain retries
  dataset: { id: pkg.taskset.id, revision: pkg.taskset.revision,
    contentHash: pkg.taskset.contentHash },
  packageHash: pkg.contentHash,
  taskIds: selectedTaskIds, // null copies the whole exact release
  purpose: "supervised_training",
  shareWithWorkspace: true,
  rewardBindingRef: selectedRewardBinding,
  definition: { instructions: taskInstructions, outputSchema: actualOutputSchema },
  targetSource: "expected_output",
});
```

Workspace sharing is an explicit copy of selected examples and their required
execution dependencies, including evaluator context. The host retains the
original package privately. A bound package can retain its existing Reward and
task format; an ordinary package needs an exact saved Reward and a real output
contract, rather than a schema inferred from answer examples.

The receipt identifies new unapproved evidence and pending target proposals.
Use the existing learning commands to grade, review and seal the appropriate
batch, then pass its exact reference to experiment preparation. Original splits
and family boundaries remain enforced. Parent approvals are never copied.
`targetSource: "none"` imports without proposals; `"approved_parent"` proposes
targets from a learning-backed package and still requires fresh approval. Reward
training accepts only `"none"`. Import creates no training Job or credit hold.
The CLI exposes `training hosted-review-dataset input.json --team-id <id>`;
native Python sync/async clients expose `training.review_dataset(...)`.

`inspectDatasetTrainingReviewPackage(pkg)` from `openpond-sdk/taskset-packages`
returns task-format defaults, the retained Reward reference, exact package/release
identity and counts. It omits original task answers, evaluator context, grader
code and files. The shared UI uses this metadata plus the existing policy-visible
Dataset population read for example selection. Python consumers can read the
same immutable package through the existing package client; the inspection helper
is a pure TypeScript convenience, not another hosted mutation.

## Exact trained result

The result read is implemented in source; hosted release verification is pending.
`client.result(jobId, { teamId })` reads `GET /v1/training/jobs/{jobId}/result`.
Native Python exposes `training.result(job_id)` in both clients, bound to the
client's workspace. The official CLI uses `training hosted-result <job-id>`.

The response retains the original base model, recipe and immutable data/config
references, current Job, outputs and execution receipt. A retained candidate pins
its final checkpoint, artifact hash and adapter composition/parent. Clients reject
changed Job/source identities, inconsistent inventories and incomplete cleanup.
The host reuses the final SFT/GRPO checkpoint verifier. Missing original requests,
qualification runs and unfinished publication have explicit candidate states.
The read creates no Model, credit reservation, training Job or serving allocation.
A registry publication ID does not establish serving readiness or model quality.
Model saving and serving control are explicit operations described below.

### Save a trained Model

`client.saveResultModel(jobId, request)` saves the exact result as a version of
its producing Model. Read `client.result(jobId, { teamId })` first, then retain
one operation ID and send `TrainingResultSaveRequestSchema` fields: `teamId`,
`name`, `expectedModelRevision` from `result.model.revision`, `submissionHash`,
and the candidate's `artifact` and `checkpointId`. The request schema version is
`openpond.trainingResultSave.v1`. Retry an uncertain save with the same body.
The client does not automatically retry writes.

`client.savedModel(modelProjectId, { teamId })` returns the Model and its most
recently explicitly saved training version. That version retains original
base/settings/data, checkpoint and parent composition independently of later
configuration edits. The name applies to the producing Model. Saving another
checkpoint selects that version; viewing or running another experiment does
not select it. Serving activation remains separate.

Native Python uses `training.save_result_model(job_id, request)` and
`training.saved_model(model_project_id, {"teamId": team_id})` in sync/async clients.
The CLI reads a `{ "jobId": "…", "request": { … } }` command file with
`training hosted-save-model <input.json> --team-id <id>` and reads the saved
version with `training hosted-saved-model <model-project-id> --team-id <id>`.
The existing Desktop operation journal retains the reviewed save for recovery.
These additions are implemented in source; deployed save/concurrency,
artifact lifecycle and serving qualification remain open.


### Read saved-Model serving state

`client.modelServing(modelProjectId, { teamId, versionHash })` reads the exact
version hash returned by `savedModel`. A changed saved version requires a fresh
read. The response includes the verified saved snapshot, its separate registry
publication, Model-scoped routing bindings, deployment/pool metadata and an
optional historical inference receipt reference. Registry and native checkpoint
hashes describe different artifacts and must not be substituted.

`active` means eligible routing metadata points to a ready deployment/pool.
It does not establish current GPU residency, a warm worker, scale-to-zero or
released billed capacity. `lastVerifiedInference` is historical, settled request
evidence for that exact registry artifact and immutable runtime. Pool consumer
counts include other uses of shared capacity. An unblocked retirement read is
an observation, not a retirement action or a provider billing receipt.

Native Python exposes `training.model_serving(model_project_id, query)` in both
clients. The CLI uses `training hosted-model-serving <input.json> --team-id <id>`;
the file contains `modelProjectId` and `versionHash`. This is read-only. Serving reads and Model activation/stop controls are implemented in source;
hosted qualification remains pending.


### Activate and stop a saved Model

`client.controlModelServing(modelProjectId, request)` sends one explicit command.
Read `modelServing` first. Use schema version
`openpond.trainingModelServingControlRequest.v1`, the current `teamId`, one
retained `operationId`, the exact saved `versionHash`, the observed registry
`artifact` reference, `expectedRevision` from `state.control?.revision ?? 0`,
`action: "activate"` and an `idleTimeoutSeconds` value from 60 to 3600.
The UI obtains these references from the Model; users do not browse artifacts.

The immutable receipt binds the actor, action, checkpoint, publication and
revision. Retain the original request across uncertain replies and retry it
explicitly; writes are never automatically retried. The receipt acknowledges
the request. Read current serving status to observe readiness and subsequent
cleanup. Background reconciliation continues without the client or Desktop.
Activation uses the host's existing supported runtime, authorization, pooled
capacity and funding owners. It does not qualify a new GPU/model combination.

For Stop, refresh serving status and use its control's `versionHash`, `artifact`,
`revision` and `idleTimeoutSeconds` with a new operation ID and `action: "stop"`.
The Model's route becomes inactive first. Original calls, reservations and
shared consumers remain protected; physical retirement runs through the existing
capacity owner. A failed or uncertain allocation remains cleanup-pending rather
than causing a replacement allocation or a claim that provider capacity is gone.
Stop does not revoke the artifact. A different checkpoint cannot replace an
active saved serving version; stop that version before selecting another.

Native Python uses `training.control_model_serving(model_project_id, request)`
in both clients. The official CLI accepts a `{ "modelProjectId": "…",
"request": { … } }` file with `training hosted-control-model-serving <input.json>
--team-id <id>`. Activation additionally requires `--yes` because it authorizes
billed serving capacity. The Desktop journal retains the reviewed command across
reopen. These controls are source implementation; actual hosted startup,
interruption, shared capacity, provider retirement and settlement qualification
remain open.


Use the returned control's `modelId` for inference. The `model:` logical-name
and `saved-model:` binding-ID prefixes are reserved for saved-Model controls;
generic binding-projection writes cannot modify those routes. Pending cleanup
for previous versions is returned in `state.cleanup` and remains independent of
the current route. A new version does not erase earlier capacity obligations.

### Local neuron-steering and activation reference

Steering and inspection authoring use the existing standalone draft operations.
Set `draft.operationType` to `neuron_steering` or `inspect_activations` and retain
an `activationForm` matching `ActivationExperimentFormDraftSchema`. It contains
a nullable model preference, prompt rows (`id`, `text`), coordinate rows (`id`,
`layer`, `neuron`, `dose`), `doseMultipliers`, normalization and token scope,
plus generation/capture/work/time limits. Numeric authoring fields are strings
so a blank or unfinished value survives save/reopen. Row IDs remain unique and
stable across edits. Inspection ignores steering dose fields.

Use `saveExperimentDraft`, `getExperimentDraft`, `listExperimentDrafts` and
`archiveExperimentDraft` with their existing workspace, owner, revision and
operation-receipt semantics. The official CLI's `training hosted-save-draft`
and related draft commands accept the same documents on compatible hosts.
Native Python has the same generated inputs and sync/async methods. Drafts
are bounded to 32 KiB over the wire. They contain no tensor or activation bytes.

The common UI exposes both methods as editable drafts, reusing its Model picker,
prompt/coordinate fields, Advanced settings, Save draft and discard recovery.
Run remains unavailable while hosted activation execution has no compatible
runtime. A saved draft is neither a published steering profile nor an admitted
execution request. Runtime preparation still must resolve exact tensor/tokenizer
identity, tokenize prompts, validate coordinates/doses and bound the whole sweep.
No training recipe, Dataset, spend cap or chat prompt is fabricated for inspection.

Read `client.modificationCapabilities(query)` before preparing a modification.
It calls read-only `GET /v1/training/modification-capabilities`. The query uses
`teamId`, `modelId`, `source` (`managed`, `local` or `builtin`) and optional exact
`revision`, `tokenizerRevision`, `chatTemplateHash` and `modelAssetId` fields.
Omit unknown values rather than inventing a pin. The response retains the exact
query/request hash, workspace/actor, checked time, expiry and one entry for each
of `neuron_steering` and `inspect_activations`. `draftSchema` describes the format,
not permission to write or execute.

Each capability observation retains `validationLevel`: `null` when execution is
unavailable, `source_validated` for an experimental staging runtime, or
`gpu_qualified` after a retained exact-model/runtime GPU run. Source validation
describes a runtime reviewed for an experimental staging trial; it is not
evidence that training or inference has already succeeded. Read the runtime's retained evidence; neither level
reserves compute, approves a charge or establishes model quality. Engram,
Decision, AlphaEdit and neuron-training capabilities use the same distinction.
The validation level stays outside native tensor descriptors and runtime hashes.

An unavailable entry explains `model_not_supported` or `runtime_not_qualified`.
The current hosted projection advertises no executable activation runtime. A
future ready entry must bind a complete dense tensor identity, runtime image/
release and retained evidence, plus prompt/variant/coordinate/dose/capture/work/
time limits. The client verifies hashes, query identity, method coverage and a
maximum five-minute observation lifetime. Call
`parseAndVerifyModelModificationCapabilities(value, query, expectedActorId)`
when the current account identity is known. A capability observation reserves
no funds/capacity, proves no warm worker and is rechecked by execution admission.
The TypeScript read has a 30-second bound and accepts an optional `{ signal }`
second argument; cancellation does not change the draft or start any operation.

Native Python exposes `training.modification_capabilities(input)` in both
clients. The official CLI reads the same query file with
`training hosted-modification-capabilities <input.json> --team-id <id> --json`.
Desktop relays the read through the existing setup owner; the common form
refreshes it for the selected model without changing any draft settings.

`neuron-steering.ts` defines exact dense-model identities, additive profiles and
residual calibration artifacts. `activation-reference.ts` defines bounded
tokenized prompt comparisons and selected-coordinate observations. Use
`createNeuronSteeringProfile` and `parseAndVerifyNeuronSteeringProfile` for
profiles, and `parseAndVerifyActivationReferenceRequest` /
`parseAndVerifyActivationReferenceResult` for retained execution evidence.
These exports are local contracts; they add no hosted execution operation.

The optional native Python `ponder_sdk.reference` executor runs a host-supplied,
loaded dense PyTorch model serially. The source example
Native Python also provides `ponder_sdk.activation_forms.compile_activation_form`.
It turns the saved raw text form into the bounded reference request using an
explicit trusted `ActivationFormTokenizer` and exact model identity. It rejects
blank required numbers, changed tokenizer/source pins and invalid coordinates;
steering includes a baseline plus the authored sweep, while inspection captures
the unsteered baseline. The example below supplies a complete adapter. Local
compilation grants no hosted admission, and fixed calibration artifacts remain
required at execution.

`python/openpond-sdk/examples/activation_reference.py` runs a synthetic CPU
network with Off, zero, signed-dose and token-scope comparisons. It captures
selected values before/after the intervention, retains exact request/model/
profile hashes, and checks that weights are unchanged. Its manual numerical
workflow lives outside the ordinary HTTP SDK test suite.

Reference semantics are zero-based coordinates, additive updates to the
post-gating input of `down_proj`, and an FP32 midpoint median of outgoing
residual norms. These are explicit proposed semantics, not a claim of reproducing
an unspecified external recipe. Baseline-prompt normalization uses a separate
unsteered prefill and freezes its statistics. Fixed normalization instead pins
an immutable calibration artifact. Prompt/decode and absolute-position scope
are separate from the calibration sample mask.

Requests bound prompts, variants, capture values, forward-token work, generated
tokens and duration. The serial reference recomputes full contexts and includes
a final inspection forward for the last generated token. It has no KV/prefix
cache or concurrent shared-model serving. Only a single-device, unquantized,
adapter-free dense model is admitted; LoRA, fused/quantized kernels, MoE and
checkpoint-specific Qwen support need separate runtime integration.

This reference makes no paid request, downloads no model and creates no hosted
Job, saved Model or serving allocation. There is no corresponding official CLI
execution command yet. Managed authoring, isolation, comparisons and serving
remain separate implementation work.


### Retain an external activation observation locally

The authenticated local server exposes `POST /v1/modification-recordings`,
`GET /v1/modification-recordings/:id?teamId=...` and the metadata-only collection
read. Point an ordinary configured training client at that loopback server;
these paths are not hosted training endpoints.

```ts
const recording = await localTraining.recordModificationObservation({
  schemaVersion: "openpond.modificationRecordingRequest.v1",
  teamId, operationId: "retain-reference-1", name: "Reference comparison",
  projectId: null, method: "neuron_steering", request, result,
});
const retained = await localTraining.modificationRecording(recording.id, { teamId });
const page = await localTraining.modificationRecordings({ teamId, limit: 30 });
```

`request` and `result` are the exact verified activation-reference output, not a
draft or arbitrary tensor dump. Inspection requires only unsteered variants;
steering requires an explicit Off baseline and an intervention. The canonical
command is bounded to 8 MiB. Reuse the original operation ID and exact command
after a lost reply; a changed command conflicts. The returned ID and first
receipt remain stable across retries and local server restarts.

The read verifies exact request/result/model hashes, capture coverage, artifact
bytes, metadata and scope. Collection reads return bounded metadata with opaque
cursors scoped to account, workspace, Project filter and search. Project IDs
organize local observations; they do not confer hosted Project permissions.
Custody is `local`, provenance is `external_observation`, and
`measurementAttestation` is `unattested`. Neither hashes nor import imply worker
execution, a grade or measured provider cost. No Job, funding hold or allocation
is created. The payload stays in the existing device database.

Native Python offers `record_modification_observation(command)`,
`modification_recording(id, {"teamId": team_id})` and
`modification_recordings({"teamId": team_id, "limit": 30})` in both clients.
The official CLI uses:

```sh
openpond experiments record-modification --local --team <id> --input-file <command.json> --json
openpond experiments modification <recording-id> --local --team <id> --json
openpond experiments modifications --local --team <id> --limit 30 --json
```

Supply `--home` and `--server-url` when the running app uses nondefault values.
The UI imports the reference example's `{request, result}` document, constructs
an immutable import command, and reuses the same local service/table/viewer.
Imported observations are not deployable Models or managed runs.

### Inspect a managed modification execution

On a host implementing managed execution inspection, read an existing execution with:

```ts
const history = await training.listModificationExecutions(teamId, {projectId, limit: 25});
const execution = await training.getModificationExecution(teamId, executionId);
```

The matching native Python method is `client.training.get_modification_execution(execution_id)` in sync and async clients. The official CLI provides:

```sh
openpond training hosted-modification-execution <execution-id> --team-id <id> --json
```

This read returns the owned execution's exact request, lifecycle phase and any retained capture. Clients verify the response hash, execution/workspace identity, request hash and complete capture coverage. A capture can be present while the phase is still `dispatching` or `stopping`; its presence does not establish resource cleanup or final cost settlement. This read starts no compute. Current runtime discovery advertises no qualified managed steering or inspection runtime.

### Compile, prepare and control managed activations

On a compatible host, `compileModificationExecution(input)` compiles a bounded raw form with the exact registered tokenizer. `prepareModificationExecution(input)` retains the compiled request, Project, name and maximum spend without starting compute. After explicit review, `startModificationExecution(input)` uses the returned execution ID, revision, plan hash, approved cap and a stable operation ID. `cancelModificationExecution(input)` retains that exact execution identity while cleanup proceeds.

The CLI equivalents are `training hosted-compile-modification`, `hosted-prepare-modification`, `hosted-start-modification --yes` and `hosted-cancel-modification`, each taking `<input.json> --team-id <id>`. Native Python provides corresponding snake_case methods in both clients. Use the exported input schemas or installed help; preserve the original command and operation ID after an uncertain reply. Start is the funded execution boundary. An unavailable capability never grants permission to start an unsupported model.

## Continual-learning grader selection

An experiment draft's `trainingForm.learningIntent.graders` optionally stores
exact learning revision references for recurring tasks. Omitting the field uses
the reviewed batch's whole grader pool. An explicit subset must retain required
gates and the training/evaluation roles needed by the hosted loop. Hosts validate
these references against the exact reviewed batch before publishing the policy.

The learning save hashes this selection and retains it in the immutable policy;
it does not rewrite the manual experiment's batch or grader binding. The retained
evaluation remains an independent candidate check. A nightly schedule uses the
authored time and timezone, waits for approved unused examples, and respects the
saved task threshold and spend limits. It does not itself enable conversation
collection, automatic data approval, or automatic serving.


Selective neuron continuation uses an exact compatible saved neuron version.
`neuronTrainingFormFromModelVersion` retains that version and its cumulative
patch, copies the parent's selection configuration, clears the target choice,
and requires reviewed new target data. `background=[]` retains the original
selection as inherited evidence; it does not report selection on the new data.
The explicit mode is `frozen_parent_fresh_residual_adam_v1`: the parent stays
frozen, fresh zero column parameters use the original dense base as their
anchors, and a fresh Adam optimizer learns a residual. No optimizer or RNG
checkpoint is resumed. Optional preservation compares against the starting
base plus parent patch. The worker verifies the exact parent bytes before
optimizer creation and exports a cumulative patch with parent, initial and
final state hashes. A runtime must explicitly advertise this mode before
admission; source packaging alone does not establish native qualification or
old/new held-out retention.
