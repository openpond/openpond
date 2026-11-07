# Datasets, experiments, and training

Use this guidance when the user asks to create or inspect a dataset, author a grader, run or improve an experiment, train a model, or learn from selected logs. The CLI is the execution interface. Guide the conversation and return useful inline UI through the available host; the app owns persisted resource attachment and the Training picker and resource sidebar.

Before preparing hosted SFT or GRPO, use `training hosted-tasksets --team-id <id> --json` to list authorized Dataset metadata, or `training hosted-tasksets <taskset-id> --team-id <id> --json` to read one exact released reference. Supply its returned `release` for the validation Dataset; the catalog record ID and release ID are different identities. The selected reward binding needs a positive evaluation grader, and validation rows must use the chosen validation split and remain separate from training families. Catalog reads do not start compute.

## Work from the conversation

Treat ordinary requests such as “check this dataset,” “edit these examples,” or “run this grader” as enough to begin. Resolve the referenced resource from the current conversation and attached experiment, read what you need, and do the requested work. Keep command syntax, executor names, invocation context, and internal IDs out of conversational replies unless they help diagnose an error or the user asks for them. The user does not need to tell you to load this skill or call a particular tool.

Use [Compact inline resource presentation](compact-resource-tables.md) as guidance, not a required template. The composer’s Training picker and right sidebar are the persistent places to select, inspect and act on attached resources. Give a brief inline summary; use a small HTML card or table only when useful to this request. Do not automatically print every dataset, repeat the resource controls, or build an all-resources tabbed dashboard. Keep useful actions visible and secondary actions in an overflow menu. A card showing a started experiment complements its canonical chat attachment. Let the content and layout fit the work.

- Inspect the current experiment and linked dataset when the app supplies their references. Otherwise discover existing resources before asking whether to reuse or create one. Ask only for choices that materially affect the work and cannot be inferred from the request or existing context.
- A dataset can be authored without a model, Profile, cloud account, or executed experiment. If the app provides a draft experiment scope, keep working in it; do not launch a run merely to give the UI an experiment ID.
- Several datasets and runs can belong to a conversation. Use explicit IDs and revisions for operations; inspecting a candidate must not silently replace a baseline or alter another run's saved inputs.
- Keep dataset creation and grader creation distinct. A request to add a grader applies to the selected dataset unless the user asks to create another dataset.

## Starting from an objective and sources

For “I want to make a model; where do I start?”, give a short next step: ask what
repeated task it should do, then offer a relevant public dataset, explicitly chosen
conversations, or user files. Explain the sequence in plain language: examples →
graders checked on good/bad answers → baseline experiment → inspect and improve →
bounded training plan → training → fixed evaluation → optional serving. Do not
start compute to answer an introductory question. Recommend prompting or retrieval
when the problem is changing knowledge rather than a learned behavior.

Inspect supported sources before promising an import. For a Hugging Face source,
`datasets inspect-source --local --input-file <path> --json` accepts an object with
`url` and optional `configuration` and `split`. Read its real columns, preview,
resolved revision, license and access restrictions. The chat path's
`datasets import-source` captures explicitly selected rows from that retained
preview (at most 25); it is a sample, not a full repository import. Its input has
`importId`, stable `operationId`, `name`, `objective`, `rows` (zero-based preview
indexes), `promptField`, and optional `expectedField`. Preserve the returned
source evidence and keep unresolved license/privacy/revision checks explicit.
Do not represent this validation sample as a train/held-out split. For larger or
file imports inspect the supported package/import schema before choosing a path;
do not invent a native picker, download support or accepted file format.

For “use my conversations”, inspect the supported `openpond import` discovery,
conversation selection and branch commands. Preview only explicitly chosen
sources, keep excluded/private material excluded, retain consent and provenance,
and review assistant answers before treating them as demonstrations. Connecting
or syncing history does not itself create qualified training tasks. Keep semantic
families apart across training and frozen evaluation.

## Discovery and inline selection

For “list my datasets” or similar discovery, use the scoped CLI. Local discovery uses `"$OPENPOND_CLI_NODE" "$OPENPOND_CLI_ENTRY" datasets list --local --json`; omitting `--local` selects the hosted/team command family. Discovery opens dataset focus without creating an experiment, selecting a returned dataset, or starting compute. Dataset-only focus has no experiment number. The composer’s Training picker selects Experiment or Model. Under Experiment, New experiment… opens the shared setup directly. Choose Evaluate, SFT or RL there and fill the relevant inputs; opening setup does not create a chat or start compute. The right sidebar holds its inputs, results and training controls. Reuse an existing experiment when the request concerns it. Keep the response bounded and relevant: a short summary usually suffices; a compact selectable table is useful when the user needs to choose among records. Do not attach all discovery results. For a specific dataset, read that resource through the CLI so its canonical reference attaches. Inspect `datasets context --local --json` if the saved selection appears missing, and surface attachment failures instead of claiming selection succeeded.

For a published OpenPond HTML picker, render Select buttons with `data-openpond-resource-kind="dataset"`, `data-openpond-resource-id="<exact-id>"`, and `data-openpond-resource-revision="<revision>"`; experiments use kind `experiment`. The host validates a real click, selects the resource, collapses the picker with Change, and queues a canonical selection message. Keep this presentation compact and use a saved-record table. Do not add scripts that call APIs or manufacture selection messages.

Use the host's existing selection interaction with exact resource references. When the user selects a record, use the available shared attach/select connection, collapse the picker to a reopenable receipt when supported, and continue the conversation. Preserve unsent composer text. Selecting data alone does not run an experiment or train a model. If the host lacks interactive selection or attachment, return concise references and accept a conversational choice without pretending the UI updated.

Inspect related experiments and graders after selection and summarize what matters to the user's objective. Distinguish running jobs from all related experiments, and graders on the selected revision from graders pinned to old runs. Use real counts; do not repeat invented example numbers. Suggest an appropriate next action without enforcing a setup wizard. Quiet resource selection need not trigger another assistant response.

## Choose the supported command family

Read the installed command help for exact flags and input contracts; capability varies by version and execution target.

| Work | CLI entry point |
| --- | --- |
| Dataset discovery, authoring, import, revisions, and validation | `openpond datasets` |
| Local dataset schema and grader authoring/checks | `openpond datasets schema`, `list-graders`, `read-grader`, `save-grader`, `test-grader`, `check-graders` with `--local` |
| Model choices, execution, saved results, cases, and comparisons | `openpond experiments` |
| Resource diagnosis and improvement | Read results, edit the selected resource, test, run, and compare through `datasets` / `experiments` |
| Model projects, training preparation/execution, status, and artifacts | `openpond training` |
| Supported continual experiment manifests and reports | `openpond continual` |

When the app provides a scoped command executor, run the CLI with `"$OPENPOND_CLI_NODE" "$OPENPOND_CLI_ENTRY"` as its prefix (`openpond_exec_command` for native agents; the existing `exec_command` for hosted chat). This uses the app's bundled installation and attaches saved results to the originating chat. Do not use the provider's unrelated shell for these workflows or copy invocation credentials into arguments.

Use that supplied prefix directly. Do not spend a command printing or probing its environment variables before every request; investigate setup only after an actual execution failure. Reuse command contracts already read in this conversation, and batch independent inspections where useful. A simple grader question normally needs one listing and, only when criteria are needed, one grader inspection.

Use `datasets context --local --json` to inspect the current scope; `datasets select <id> --local --expected-revision <revision>` selects an existing dataset. `datasets new-experiment --local --operation-id <stable-id>` creates a configuration scope without compute. Scope selection/rename use `select-experiment` and `rename-experiment`; check their current help. These commands require app-supplied context. Mere `datasets list` discovery does not attach all records.

Use the application's supplied local server context and OpenPond home when present. Pass that configured home with `--home <selected-home>`. Check this context before diagnosing missing authentication. Do not guess a second installation, scrape credentials, or switch teams to get an operation to succeed. Local dataset commands use `--local`; hosted operations have their own explicit destination/account options. Local experiment execution may still call a paid remote inference provider.

For Diagnose, Improve, or grader repair, read [Diagnose and improve](diagnose-and-improve.md).

## Dataset and grader work

For a simple question about the selected dataset, use the exact dataset ID and revision from the attached context. Do not ask the user to identify a dataset that is already selected. `this dataset` refers to the sole attached dataset; multiple distinct datasets require disambiguation.

For "what are my graders?", start with `datasets list-graders <dataset-id> --local --expected-revision <revision> --json`. If the grader's criteria need inspection, use `datasets read-grader <grader-id> --dataset-id <dataset-id> --local --expected-revision <revision> --json`; both attached grader IDs and native grader IDs are accepted. Alternatively use `read-grader <dataset-id> --grader-id <grader-id>`. This returns the definition, readable verifier source, and a page of fixtures, without the whole dataset. `--offset` and `--limit` page the fixtures. Do not decode dataset exports or use Python for this lookup. Read a whole dataset only when its tasks or source files are needed.

Answer small inspection questions briefly: identify the dataset and revision, name the graders and explain their checks, then distinguish fixture checks from model results. Progress updates should describe the operation being performed, not speculate about shell syntax or implementation choices. Read-only inspection does not require extra dataset/grader cards. For improvement advice, lead with the strongest confirmed finding and the next useful step; keep broader suggestions secondary.

Use the bundled openpond-taskset-authoring skill for deeper task design, split isolation, provenance, and grader calibration. Inspect source schemas and representative examples before importing or mapping data. Preserve source provenance and save useful drafts even when validation is incomplete. Read the supported dataset schema before authoring an unfamiliar request.
`datasets schema --local --json` returns the task schema. To inspect another
section, supply `--input-file <path>` containing `{"kind":"grader"}`,
`{"kind":"fixture"}`, `{"kind":"draft"}`, or `{"kind":"file"}`. Prefer the
relevant section to dumping the full draft schema. A create input is
`{"name":"…","draft":{…},"files":[…]}` with a stable `--operation-id`;
include only authored fields and let the owner assign identity and timestamps.
Use the taskset-authoring skill for verifier/fixture contracts. Installed CLI
schemas and those maintained references are the source of truth; ordinary data
authoring does not require searching the application repository for its API.

Test graders against meaningful known-good and known-bad examples before claiming they are qualified. Distinguish saved data, structural validation, grader checks, and model performance. Editing a grader creates new evidence; it does not retroactively change the original experiment result.

## Experiments and improvements

Discover available models before selecting an evaluated model. In a scoped chat, persist the explicit choice with `openpond datasets select-model <providerId/modelId> --local --json` using an exact entry from `openpond experiments models --local --json`. Read the current selection with `openpond datasets context --local --json`; `evaluationModel` is the evaluation target. A user-named model overrides that saved choice once resolved to an available catalog entry; ambiguous names need clarification. Do not substitute the chat model or another provider when the chosen model is unavailable. The agent answering this chat and the model under evaluation are separate choices. Pin the dataset revision and grader configuration; use a stable operation identity for replay where supported. Reconcile an uncertain submission before issuing a new run.

For an independent saved Dataset, `experiments run --local --input-file <path>`
uses this input **without `--team`**. It does not accept the workspace SDK's
`configuration` or `request` wrapper:

```json
{
  "datasetId": "<saved dataset id>",
  "revision": 3,
  "operationId": "reviewed-evaluation-1",
  "maximumCostUsd": 1,
  "taskLimit": 10,
  "seed": 0,
  "maxOutputTokens": 1024,
  "models": [{"providerId": "openpond", "modelId": "<exact catalog id>"}]
}
```

Take `providerId` and `id` from `experiments models --local --json`; put that
entry's `id` in `modelId`. Providers are `openpond`,
`custom-openai-compatible`, `claude-code`, and `codex`; select 1–8 distinct
models. The saved revision must be positive and pins its Dataset and graders.
`operationId` is a 1–120 character value inside the JSON. `taskLimit` is 1–100,
defaults to 10, and takes the first tasks in the saved package; `seed` records
the case seed, rather than selecting a random subset. Its range is
0–2147483647 and its default is 0. `maxOutputTokens` is 1–262144, defaults to
1024, and is capped by each model's output limit.

`maximumCostUsd` is the total positive ceiling, at most 10000, divided across
the selected models and covering metered inference and grading. It may be
omitted only when every selected model is `codex` and the Dataset has no
model-judge grader. Subscription dollar accounting remains unknown. The
example's ceiling is illustrative; use the user's authorized bound.

For a prepare-only request, read `datasets context --local --json`, the exact
saved Dataset revision, its graders/check results, and
`experiments models --local --json`, then write and review the input file.
Stop there: `run` executes and may incur metered charges. There is no independent
Dataset prepare/dry-run command. `prepare-harness` and `prepare-profile` belong
to their released Harness/Profile workflows. Do not use them as substitutes.
When execution is authorized, send the reviewed file through the scoped CLI;
reuse its operation identity only for the exact same input after reconciling
status. Workspace operations with `--team` use their separate configuration
contract.

Use existing authorized limits. Ask for a missing spending ceiling when the selected operation requires one. A subscription run with unavailable dollar accounting must not be described as costing zero.

Inspect status, results, coverage, and failed cases before claiming success or proposing an improvement. Report pass rate only when the grader defines pass/fail; otherwise report the actual score. Compare matched inputs when making improvement claims, and identify changed-input comparisons.

For "are there open experiments?", filter the returned experiment summaries by the exact selected datasetId and inspect every returned page before reporting a total. Keep active runs separate from completed history and unsent experiment drafts. Include intermediate dataset revisions in the history count rather than reporting only the oldest and newest runs.

Use the resource-specific Diagnose/Improve guidance above. The older source-component improvement API is not the general chat improvement path.

## Composer actions

Resource selection changes the attached context without sending a message. The
Training picker chooses an Experiment or Model and the sidebar exposes the chosen
record and run. New experiment… opens its dataset dialog and creates a configuration
only on confirmation. Dataset and grader inputs are inspectable in the sidebar.
Evaluate, Diagnose and Improve open a reviewable request that is added to the
composer unsent. Add grader opens square choices: LLM judge, Human assessment,
Code grader, and Python correctness. Clicking a choice immediately drafts the
request with the selected dataset ID and revision; the user presses Enter to send.
There is no grader description field or second add button. Preserve existing
graders, original run pins and unsent text. Collapsing sidebar sections does not
change the saved selection.

New training in the sidebar opens hosted-training preparation. Review cost in chat drafts a cost-inspection request for the selected model, method and sizing; it does not upload, submit or allocate a worker. Prepare in chat drafts a capped hosted-training plan, not a generic improvement or an immediate job submission. Use the official hosted training capabilities and preparation commands, inspect model/data compatibility, and present the plan and cost before starting. Serving/deploying a resulting model is a separate operation from training; do not silently substitute local training, Profile edits, or deployment.

## Training and continual learning

Discover the supported model, recipe, execution destination, and training-data requirements. Reuse existing projects and preparation receipts where appropriate. Evaluation evidence is not automatically approved training data, and frozen evaluation examples must retain their evaluation role.

Before experiment submission, training submission or serving activation, use the
current capability/quote evidence to show an estimate, assumptions, hard spending
cap and included costs, or state why a reliable estimate is unavailable. Afterward
separate measured/estimated cost, pending billing and remaining campaign budget;
a per-job meter is not the whole campaign cost. Reuse the agreed cap rather than
asking for it again. A cold managed model can be selectable before capacity is
warm: inspect actual readiness and current startup/idle/retention behavior,
explain separate serving charges, and do not promise a latency or start serving
merely because a model was inspected.

Inspect serving capacity with `training hosted-serving-pools --team-id <id>`
using the same account home and API origin. Listing does not prepare or wake a
pool. When the user has authorized serving setup, use
`training hosted-base-serving-prepare <base-profile.json> --team-id <id> --yes`,
where the strict input is `{"baseProfileId":"qwen3-8b-b968826d"}`. This prepares
the configured serving provider's capacity; it is separate from inference and
may incur provider charges. Do not use a training worker as a serving pool or
invent an adapter artifact for base-model setup. Inspect readiness and refresh
`experiments models --local --json` before choosing an evaluation model. Retire
authorized capacity through `training hosted-serving-pool-retire <input.json>
--team-id <id> --yes`, with `{"poolId":"<owned-pool>","reason":"<reason>"}`;
then recheck inventory until retirement completes. A zero-minimum pool is not
proof that a worker has already scaled down or that billing has settled.

Inspect saved canonical Models first with `training projects --json`, then
`training inspect-project <local-model-project-id> --json`. These read-only local
commands return the saved Profile, recipe presence, execution settings and exact training/evaluation Taskset
references, whether each exact revision/hash exists, split counts and grader pins
without exporting tasks or private verifier bytes. They do not reconcile or start
background work. Optional `--profile` narrows the local Profile explicitly.
Chat `datasets context` describes portable Dataset workspaces and experiments;
it is not the canonical Model/Taskset inventory. A portable `datasets read` 404
does not establish that an imported canonical Model Taskset is missing. If the
canonical inspector confirms the exact pins available, preserve them and proceed
with planning rather than repeating import or reporting that catalog error as a
blocker. Hosted readback alone does not establish local package availability.

To bring a hosted Model and its pinned Taskset packages into the local app, use
`training pull-project <hosted-model-project-id> --profile <local-profile-id> --json`.
This uses the local app API and its signed-in hosted account; do not pass the hosted
API origin as the pull command's API URL. The existing owner checks local changes,
downloads immutable package references and preserves their asset/verifier bytes.
Read the returned exact references before preparing another run. Pulling does not
start training or serving. For an explicitly requested historical projected pin
that cannot resolve through the portable catalog, `--snapshot-file <path>` accepts
`{"schemaVersion":"openpond.modelProjectPullSnapshot.v1","package":<immutable package>,"taskset":<saved projected Taskset>}`.
This is an explicit recovery input, never an automatic fallback. The app verifies
the authenticated Model pin and Profile, recomputes the complete projection, and
requires canonical equality before the atomic import. Preserve both original files
and their distinct hashes; never reconstruct a missing package or override a hash.
Do not reauthor an old published dataset to substitute for a newer canonical package.

Use the current CLI's prepare/start/status/watch/artifacts operations for the selected backend. Return retained job/model references and read saved completion state; a submitted job is not a trained model. CLI flags that acknowledge submission do not create user authorization or enlarge a budget.

For an explicitly authorized first-image SFT qualification on a host that has
activated this operator path, `training hosted-import-sft-qualification
<input.json> --team-id <id> --json` retains an unchanged, already staged
submission in the normal preparation owner. The strict input has
`schemaVersion: openpond.trainingSftQualificationPreparationImport.v1`, a known
`preparationId`, the reviewed `qualification` reference (`authorizationId`,
`operationId`, `authorizationSha256`), a real ordinary preparation `request`
and the exact authored `submission`. Author its idempotency key as
`manual:<preparationId>` before staging and grant review. The server must match
the current grant, configuration, sealed reviewed batch, evaluation source and
finite whole-job usage quote. This command neither grants image support nor
starts compute. Retain its receipt and use the separate normal `hosted-start`
with explicit authorization; an unavailable operator path is not permission to
submit directly or change immutable source bytes.

For a new GRPO stage from a trained version, retain `parent` in the preparation
JSON: producing `jobId`, exact `artifact` (`id` and `contentHash`), `checkpointId`
and `adapterMode` (`residual_append`, `shared` or `sequential_merge`). Obtain the
references from the owned producing Job and its retained outputs, not its name
or an inference alias. Both ordinary preparation and model-first preparation
accept this contract when activated by the host. Admission still checks the
published final checkpoint and qualified runtime/composition. A mode appearing
in a schema does not establish its availability. New stages reset the optimizer;
interrupted recovery is separate. Current SFT cannot continue a checkpoint.
Preserve an unavailable parent and report the reason; never silently start from
the base instead. Saving a draft with a parent starts no compute.

For model-first manual SFT/GRPO setup, use `training hosted-prepare-experiment
<draft.json> --team-id <id> --json` when the host supports draft preparation.
Its input uses `openpond.trainingExperimentSetupRequest.v1`: exact base model,
method-specific settings, a sealed reviewed batch, stable operation ID, name,
Project (or null) and maximum spend. The service owns configuration creation;
do not send the user through New Model first. Retain the request and the full
returned wrapper receipt. This prepares without starting compute or a recurring
policy. After reviewing its limits and obtaining the user's execution authority,
`training hosted-start <receipt.json> --team-id <id> --yes --json` accepts the
wrapper directly. On a lost preparation reply, reconcile the same operation and
exact input; changed inputs require a new operation. Never recreate a submitted
job because its chat attachment failed.

To explicitly save an experiment's recurring SFT or GRPO learning policy, use
`training hosted-save-experiment-learning <request.json> --team-id <id> --json`.
Its `openpond.trainingExperimentLearning.v1` input contains `teamId`, `projectId`
(or null), stable `draftId` and `form` (the training form without
`learningConfiguration`). The form's `learningIntent` holds the enabled state,
schedule and spending limits. Incomplete intent may remain in a saved draft;
policy save requires an exact pinned base, sealed reviewed batch, retained
evaluation and name. Obtain the user's authority for that schedule and its
limits before saving an enabled policy. This command saves the policy; it does
not start the manual experiment or activate serving.

Retain the exact request and returned `inputHash`, `configuration` and `policy`
references. On an uncertain response, retry the unchanged file so the service
can recover the same save. Updating or disabling the saved policy requires both
`expectedConfiguration` (`id`, `expectedRevision`, `expectedEtag`) and the exact
`expectedPolicy` reference. A subsequent `hosted-prepare-experiment` request can
select that saved configuration through `configuration`, with the exact saved
base and settings. Preparing never enables or changes the recurring policy.

Read a retained preparation with `training hosted-preparation <preparation-id>
--team-id <id> --json`. Discover preparations with `hosted-preparations`, following
`nextCursor` through `--cursor`; `--project-id` and `--limit` narrow that read.
To cancel before a job is submitted, use `training hosted-cancel-preparation
<receipt.json> --team-id <id> --json` with the exact retained receipt/revision.
This accepts either the model-first wrapper or the ordinary preparation receipt.
Once submitted, use the job cancellation operation instead. Reads never start,
cancel or replay a run.

For learning from logs, resolve the selected sources and the requested recurrence and budget. Inspect `openpond continual` capabilities before promising unattended scheduling; a manifest run is not proof of an enabled background learning policy. Importing or syncing logs alone does not enable training.

## Chat resource attachment

Preserve app-provided execution context. Use supported CLI attachment/context behavior when the installed runtime supplies it; do not invent session flags, set another chat's identity, or parse human-facing terminal decorations into resource records.

Include the exact returned resource IDs, revisions, and status in the result when useful. The app should attach and track these through its server-owned resource events. Until that integration is available, report the saved references honestly; do not claim the resource controls updated or that a resource was attached solely because a CLI command succeeded.

### Retained training jobs in chat

When the app supplies scoped CLI context, local training start/status and hosted start/submit/status commands retain the canonical job in the originating experiment scope. Local jobs keep their Model Run, model/version and artifact lineage; hosted jobs keep their API origin, workspace and hosted Model Project identity. These are training references, not graded evaluations. Inspect a saved job with the matching local or hosted status command to refresh it; do not submit a replacement because chat attachment failed. Hosted commands outside the app remain standalone. Never infer a trained model or successful artifact from a running job, and use the existing artifact/receipt commands before claiming training produced usable output.

### State-aware actions

Use the Training picker and the selected experiment’s sidebar actions; do not direct users to a removed plus/chat menu. Check current controls before describing a UI path. Dataset/workspace or model changes require fresh evaluation evidence; an unchanged completed run leads to result and coverage analysis. Improve makes a targeted change, validates it, and evaluates it within the authorized scope; it does not automatically train or deploy a model. Repeat run is an explicit chat action and always creates separate evidence after reconciling uncertain submissions.

The independent chat experiment runner currently evaluates all graders in the selected dataset revision. Selecting one grader is an inspection/test focus, not a run filter. This runner does not expose saved-answer regrading through the independent CLI route; do not claim that it does or repurpose grader fixture tests as experiment results. Team-owned scoring has its own CLI operations and authority. Changed graders require a new evaluation unless the owning backend exposes compatible regrading.

Setup and row inspection stay in the controls. Execution and improvement actions show a compact request preview, then append an unsent request with exact dataset, retained run, grader, and evaluation-model references. Opening an action never sends it. Prepare in chat requests a hosted plan, model options, data requirements, and cost without uploads or a training submission. Serving/deployment remain separate. Dataset discovery still requires no numbered experiment.


### Execution destination

The experiment remembers executionLocation (local or cloud), independently of evaluationModel. Read it with datasets context; use datasets select-destination local|hosted --local --json through the scoped executor for an explicit conversational choice. Prefer the destination pinned to the current draft over later scope changes. Local is the default for new working data and configurations. An existing hosted record retains its owning backend.

For independent installation datasets, experiments run --local orchestrates locally; experiments run-cloud --local requests hosted execution through the local app bridge and publishes the required version using the existing owner. Hosted execution supports available OpenPond models, not Codex subscription models. Team/Profile resources have separate capability and ownership rules: inspect those commands and report an unsupported combination instead of moving the resource or guessing a fallback. Merely choosing Hosted does not upload data or run anything.

Train prepares hosted training separately from this evaluation setting. Inspect supported preparation and publishing commands, upload only the required saved assets, and retain the local source and upload lineage.

### Training history in Experiments

`openpond training hosted-executions --team-id <id> --project-id <id> --limit 30 --json` reads the canonical training history with names, method, exact retained model/data references, current state, reported spend and a continuation cursor. Optional `--dataset-hash`, `--search` and `--cursor` filters run before pagination. This is read-only and creates no preparation or Job. Training entries retain their Job IDs and use normal training status/results/cancel commands; they are not graded evaluation manifests. Missing historical references remain unknown. Source support does not establish that a particular hosted release has activated the endpoint.

## Standalone experiment drafts

Use `openpond training hosted-drafts --team-id <id> --json` to find creator-owned
saved drafts, with `--project-id`, `--search`, `--archived`, `--cursor` and
`--limit` as needed. Read an exact document with `hosted-draft <id>`.
`hosted-save-draft <input.json>` accepts the shared ExperimentDraftSave contract:
workspace, stable operation ID, expected revision, optional Project and typed
draft. Revision zero creates; editing uses the returned revision. On a lost
reply, explicitly retry the same operation and request before making another
edit. Preserve local edits on revision conflict; do not force a newer revision.

`hosted-archive-draft <id> --operation-id <id> --expected-revision <n>` retains the
document/history. A save against its current archived revision restores it.
These authoring operations do not require paid-execution confirmation and never
start training, stage examples or create an immutable experiment run. A returned
draft is not a run attachment. Use a supplied canonical draft reference, or list
and read records; do not derive a hosted draft ID from a chat scope or label.
Normal preparation, funding and explicit start controls still apply to execution.

Training drafts can retain `trainingForm.gpuSelection` with either an automatic
objective or an exact manual offering and GPU count. Keep that choice when saving,
reopening or editing a draft; do not replace an unavailable explicit offer with an
automatic choice. Draft selection is authoring state. Current live eligibility,
preparation, exact estimate review and funded start remain separate checks.

Saved chat experiment settings use this same standalone draft owner when the host supports it. Chat scopes retain an authorized reference; reopening reads the canonical document instead of treating a chat metadata snapshot as current settings. Saving before the first message creates no chat. Discover a saved draft through the commands above or the host picker; its draft ID is not an execution ID. Preserve the editor's reviewed revision during a save, reconcile the original operation after a lost reply, and do not silently replace newer settings discovered by background refresh.


Read `openpond training hosted-hardware-catalog --team-id <id> --json` for versioned hardware specifications and refresh metadata. This catalog stores no prices or stock; `requires_live_workload_check` is a candidate, not execution approval. Use `hosted-gpu-catalog` for current offers and canonical preparation/estimate review before starting work. A listed GPU or its maximum per-Pod count does not establish capacity, supported model size, or runtime compatibility.


For a selected model and method, pass `hosted-gpu-catalog workload-query.json --team-id <id> --json`. The query contains `teamId`, exact `modelId`/`modelRevision`/`tokenizerRevision`/`chatTemplateHash`, `method`, `loraRank` and `gpuCount`. It returns the query hash, an opaque provider account scope, Pod/cloud/country/CUDA constraints, short expiry and list-price basis. Unsupported inputs return their reason and no offers. Without a workload query, this command is only an overview. Neither response approves execution; reprepare changed inputs and obtain the current canonical cost review before paid start. Expired, missing-scope or substituted replies fail instead of becoming a selection.


For exact estimate review, use `openpond training hosted-estimate <request.json> --team-id <id> --json`.
The source request may reference a saved preparation, a configuration revision or
an exact submission. Availability and calibration evidence depend on the configured
host; a missing route is not a zero-cost estimate. Retain explicit unknowns and keep current hourly rates
separate from expected totals. A preparation estimate's `review` can be supplied
to the existing start control; changed inputs, provider context, runtime, expired
review or increased rate require another review. Estimates do not reserve credit,
allocate compute or increase the run's approved cap.

The prepaid training policy is implemented in source; hosted qualification is
pending. On hosts with this policy, new managed training Jobs reserve the full
approved cap from available included/prepaid credit. Workspace owner or overage
permissions do not replace credit, and a parent reservation cannot lend postpaid
funds to a training Job. Preserve the current preparation on a credit denial;
adding settled credit and retrying the same retained operation is separate from
creating a new run. An estimate or pending credit purchase is not spendable money.

Timing calibration source can return a `partial` estimate after at least three
clean matching completed runs. Read the sample counts, unknowns and execution
planning range together. The range is an observed minimum/maximum, not a confidence
interval or promised completion time. Current calibration stays within the same
actor/workspace and exact data, recipe, budget, GPU/count, placement and image;
it does not scale by model size or reuse another customer's private history.
Queue wait and costs without complete measured coverage remain unknown.
A `gpu_allocation` cost component can reprice conserved billable allocation time
from at least three exact completed runs at the current GPU-plus-disk Pod rate.
It includes shared allocation weights and GPU count once. Other GPU phase rows
are included in that aggregate; do not sum another phase charge or multiply by
GPU count. A numeric GPU component does not establish a whole-run total, a
minimum charge, available credit or permission to increase the cap.


On hosts implementing funding reads, use `openpond training hosted-funding request.json --team-id <id> --json` before requesting paid start. The `openpond.trainingFundingRequest.v1` request includes `teamId`, positive `maximumSpendUsd` and an optional exact saved `draft` reference (`id`, `revision`, `contentHash`, `projectId`). This advisory read checks the whole cap, current holds and member policy without reserving credit. Restricted viewers receive no account balances. Available usage coverage and prepaid wallet dollars are different values; discounts can make their amounts differ.

After saving the exact draft, `hosted-funding-handoff request.json --team-id <id> --json` accepts `openpond.trainingFundingHandoffRequest.v1` with the same workspace/cap and a required draft reference. It returns a grantless Billing link only for current purchase permission. The command does not open a browser, save a card, buy credit, reserve funds or start training. Web sign-in remains separate from CLI authentication. Preserve the original experiment, recheck settled funding and obtain a fresh estimate/review on return; never treat a link, pending payment or a covered preview as admission authority. Hosted deployment and complete UI return qualification remain open.


Training-data authoring uses the existing learning owner. Create/publish an exact task format and direct source, submit complete example envelopes or JSONL with stable producer keys, grade/review the actual evidence and targets, then seal a `supervised_training` or `reward_training` batch. Importing is not approval. Use `openpond learning <get|list> <kind> ... --team-id <id>` and `openpond learning command --input-file <path> --team-id <id>` with the existing command schemas; keep operation IDs stable on retries. The SDK's `OpenPondLearningClient` and native Python learning operations expose the same commands.

For model-first experiments, pass the exact sealed batch reference to canonical experiment preparation. Do not create a saved Model merely to select a batch, and do not replace target approval, reward grading, split/family separation or immutable references with a dataset label. The shared UI can open the existing import/review/batch tools inside the retained experiment and select the batch without starting training. Its import editor pins the format release until an explicit release change.

For a retained published Dataset, the new `training hosted-review-dataset <input.json> --team-id <id> --json` command copies selected examples into workspace review. Check installed help and host support first; deployed qualification of this path is pending. The `openpond.datasetTrainingReviewRequest.v1` input requires `teamId`, a stable `operationId`, exact `dataset` release, complete `packageHash`, `purpose` and explicit `shareWithWorkspace: true`. `taskIds` selects exact tasks; null selects the whole release. For an authored Dataset, `datasets read <id> --team <id>` retains its publication release and package hash; SDK consumers can use the exact Taskset package read. Ordinary packages also need an exact saved `rewardBindingRef` and actual task instructions/output schema in `definition` if the package does not retain them. Do not invent a grader or infer an approval contract from expected answers.

Explain workspace sharing before copying personal data. The operation creates a source, task format and unapproved evidence; `targetSource: "expected_output"` or `"approved_parent"` creates supervised target proposals requiring fresh grading/review. It creates no Model, batch, preparation or Job. Retain the receipt after success and retry the identical request after an uncertain response. Continue with the existing learning review and seal commands using its source/evidence references. The original Dataset's splits and family boundaries remain enforced; importing held-out examples does not make them training examples. The shared training-data panel now has a Published Dataset view in source: choose a release, select examples using policy-visible previews, retain its format or choose a workspace format, then explicitly confirm sharing before import. Its verified receipt opens the existing source-filtered review tools. Keep the original request on uncertain retries. Hosted import/review qualification remains pending; local Dataset-review preparation remains unavailable.

For an exact trained result, use `openpond training hosted-result <job-id>
--team-id <id> --json` with the configured account home. This source addition
requires a compatible hosted release. It returns original base/settings/data
references, retained outputs/receipt and the verified final checkpoint when
available. An unavailable request or unfinished publication is explicit. The
read does not save a Model or activate serving; a registry artifact ID alone
is not readiness. Never replace a missing trained checkpoint with its base.

To save a completed trained result, read `training hosted-result` and require
its retained candidate and current Model revision. Create a command file with
`jobId` and `request` matching `TrainingResultSaveCommandSchema`. The request
contains `schemaVersion: "openpond.trainingResultSave.v1"`, workspace `teamId`,
one stable `operationId`, editable Model `name`, `expectedModelRevision`,
`submissionHash`, candidate `artifact` and `checkpointId`. Run
`openpond training hosted-save-model <input.json> --team-id <id> --json`.
Retry an uncertain response with that original command. This selects the exact
checkpoint as a version of the producing Model; its name applies to that Model.
Use `training hosted-saved-model <model-project-id> --team-id <id> --json` to
read the explicitly saved version. Saving does not activate serving. These
source additions require a compatible hosted release; deployed lifecycle proof
remains pending.


For a saved Model's serving state, retain its saved version `contentHash` and
write a JSON input containing `modelProjectId` and `versionHash`. Run
`openpond training hosted-model-serving <input.json> --team-id <id> --json`.
This read distinguishes publication/qualification, routing, shared pool consumers
and historical verified inference. It creates no capacity and stops no routes.
Active routing does not prove warm GPU residency; a past inference does not
prove current load, scale-to-zero or completed provider billing. Hosted runtime/lifecycle qualification remains pending; explicit controls are
described below.


To activate a saved Model, read its current serving state and retain a command
file `{ "modelProjectId": "…", "request": { … } }`. The request uses
`openpond.trainingModelServingControlRequest.v1`, `teamId`, one `operationId`,
`versionHash`, the observed registry `artifact`, `expectedRevision` (zero before
its first serving request), `action: "activate"`, and `idleTimeoutSeconds`
(60–3600). Run `openpond training hosted-control-model-serving <input.json>
--team-id <id> --yes --json` only after the user authorizes billed serving.
For Stop, read fresh state, retain the control's exact version/artifact/revision/
idle timeout and use a new operation ID with `action: "stop"`; `--yes` is not
required for Stop. Do not substitute artifact revocation for stopping a Model.

Never mint a new command on a timeout: explicitly retry the original file and
operation ID, then read serving state. Receipt acceptance is separate from worker
readiness and physical retirement. Shared consumers, original calls and pending
settlement can retain capacity after routing stops. Failed allocation cleanup
must reconcile before replacement capacity. These contracts are implemented in
source; hosted activation, stop and provider settlement qualification stay open.

Neuron steering and activation inspection have shared draft, compilation and
managed lifecycle commands, plus an optional local Python numerical reference.
Managed execution still requires a qualified runtime; current discovery advertises
none. The source distribution's `examples/activation_reference.py`
uses a synthetic dense CPU model and separately installed PyTorch; it makes no
authenticated API call or paid allocation. Its before/after coordinate captures
and signed/zero-dose checks do not qualify a pretrained checkpoint, adapter,
quantized runtime, batching or managed serving. Do not translate its result into
a training Job or claim that a saved profile changes checkpoint weights. Consult
installed help for actual commands and keep proposed capabilities distinct from
executable ones.

Their authoring configurations now use ordinary standalone drafts on compatible
hosts. Use `training hosted-save-draft <input.json> --team-id <id> --json`, then
`hosted-draft`, `hosted-drafts` or `hosted-archive-draft` with the existing owner,
expected revision and retained operation-ID semantics. The document's
`operationType` is `neuron_steering` or `inspect_activations`; `activationForm`
contains the nullable model preference, stable prompt/coordinate row IDs,
string-valued editable numbers, dose multipliers, normalization, token scope
and capture/work/time limits. Use the exported `ActivationExperimentFormDraftSchema`
or native generated input rather than guessing fields. Keep documents within
the existing 32 KiB limit and never put tensors/capture payloads in them.

An incomplete saved configuration is not an admitted profile or execution. Do
not send it to SFT/GRPO preparation or mint a training Job, Dataset or spend cap.
Hosted steering/inspection Run is still unavailable; saving a draft and installing
this skill do not establish a worker capability.

Discover activation-runtime support with `openpond training
hosted-modification-capabilities <input.json> --team-id <id> --json`. Check
installed help and use the configured account home. The query file contains
`teamId`, `modelId`, `source` and any known exact `revision`, `tokenizerRevision`,
`chatTemplateHash` or `modelAssetId`; omit unknown fields. Verify the echoed query,
workspace/actor, observation hash/expiry and method entry. Current source returns
`model_not_supported` or `runtime_not_qualified`; it does not advertise an
executable activation worker. A future ready entry requires exact tensor/runtime
identity, qualification evidence and resource bounds. Revalidate at admission;
the read is not a quote, spend approval, reservation or warm-worker receipt.
Do not replace an unavailable intervention with ordinary inference.


For local text-to-request compilation, the native Python SDK provides
`ponder_sdk.activation_forms.compile_activation_form` with an explicit exact
model identity and trusted `ActivationFormTokenizer`. Reuse the source example
rather than inventing token IDs or filling blank numeric controls. This is a local
Python function, not a CLI command or hosted admission. Fixed calibration artifacts
must be retained and supplied to the executor as well.

### Local activation observations

Use installed `openpond experiments --help` and the running app's configured
`--home`/loopback `--server-url`. The official CLI supports:

- `experiments record-modification --local --team <id> --input-file <command.json> --json`
- `experiments modification <recording-id> --local --team <id> --json`
- `experiments modifications --local --team <id> [--project <id>] [--search <text>] [--cursor <opaque>] [--limit <1..100>] --json`

The command file is `ModificationRecordingRequestSchema`: schema version
`openpond.modificationRecordingRequest.v1`, workspace, retained operation ID,
name, nullable Project, method and exact activation-reference request/result.
Keep the canonical payload within 8 MiB. A pure inspection has no intervention;
a steering comparison includes Off and an intervention. Reconcile/retry the
original command after a lost reply; never change it under the same operation.

These commands retain/read local, immutable, externally supplied observations.
They verify integrity/coverage and do not attest measurements, infer semantic
features, assign grades or report provider spend. They never start training,
reserve credits or activate serving. Account/API-origin and workspace scope are
enforced by the existing app service. They do not upload captures to a hosted
endpoint. Do not treat an imported observation as a managed execution receipt.

### Inspect retained managed capture evidence

Use `openpond training hosted-modification-executions --team-id <id> --json` to discover the current creator's canonical execution history, independently of local drafts or browser recovery journals. Optional `--id`, `--project-id`, `--method`, `--phase`, `--limit` and `--cursor` retain the same scope on every page. The metadata list includes immutable execution and plan identity, exact model, current phase and spend cap; it reads no capture artifacts and starts no work. Open a listed execution by its exact ID for verified request and result evidence.

Use `openpond training hosted-modification-execution <execution-id> --team-id <id> --json` for an existing owned execution on a compatible host. This read verifies its exact request and any complete retained activation capture. Report the returned lifecycle phase: a capture can be available while dispatch or cleanup is still active. Do not describe capture availability as completed execution, released GPU capacity or settled billing. This command starts no work. Use the following separate commands only for an explicit managed execution request:

- `training hosted-prepare-modification <input.json> --team-id <id> --json`
- `training hosted-start-modification <input.json> --team-id <id> --yes --json`
- `training hosted-cancel-modification <input.json> --team-id <id> --json`

Compare two retained variants with `openpond training hosted-compare-modification
<execution-id> --team-id <id> --baseline <variant-id> --candidate <variant-id>
[--prompt <prompt-id>] --json`. Both variant IDs and any prompt must come from
that exact execution request. Either variant can be a profile, so the same
command covers Off/profile and profile/dose comparisons. It reads the existing
canonical execution, verifies retained request/result identity and starts no
work. The JSON includes original prompt tokens and masks, retained generated IDs,
coordinate captures and candidate-minus-reference differences. Capture differences
are unavailable after a causal token-prefix divergence, even when token IDs later
match again. Missing evidence stays explicit. Dose differences require matching
model, normalization, token scope and targeted coordinates; they are requested
doses, not measured quality or a grade. The native Python helper
`ponder_sdk.activation_comparison.verify_and_compare_activation_reference_result`
provides the same verified projection for retained bytes, with
`activation_dose_comparison` for profile doses.

On a compatible host, inspect saved profile Models with
`training hosted-steering-profiles --team-id <id> --json`,
`training hosted-steering-profile <profile-id> --team-id <id> --json` and
`training hosted-model-version <model-project-id> --team-id <id> --json`.
Use `training hosted-save-steering-model <input.json> --team-id <id> --json`
only for an explicit Save Model request: its schema binds the exact execution,
variant, result/profile hashes, retained operation ID and expected Model revision.
`training hosted-archive-steering-profile <input.json> --team-id <id> --json`
uses the current profile revision and original retry semantics. Saving or
archiving a profile does not change checkpoint weights, establish serving
readiness or authorize paid execution.

Prepare accepts the existing complete activation-reference request, exact model capability query, retained operation ID, name, nullable Project and maximum spend in USD. The host resolves runtime authority; never put capabilities, worker claims, provider identifiers or ledger records in the command. Local tokenization adapters do not establish hosted qualification.

Start and Cancel retain the execution ID, new operation ID, exact preparation `planHash`, `expectedRevision` and action. Start also requires the explicitly approved full `approvedMaximumSpendUsd`; `--yes` authorizes that paid request. Mutation receipts contain immutable public metadata from the original operation, while the separate read returns current state and retained capture. After a lost reply, reconcile the exact original command and operation ID; do not automatically repeat Start with a new operation.

The current server capability reader admits neither Prepare nor Start until both an exact qualified runtime and its production dispatcher are registered. An unavailable response starts no compute. Cancel follows the existing cleanup owner; an issued effect remains owned until positive cleanup and settlement. Public result upload remains unsupported.

`openpond training hosted-compile-modification <input.json> --team-id <id>` compiles bounded raw activation prompts and coordinates using the host’s exact registered tokenizer. Verify the returned form and input hashes before preparation. This read-only CPU operation reserves no funding or GPU and grants no execution authority. It remains unavailable until exact tokenizer assets and a qualified runtime are registered.

## Saved steering Models and original calibration

For saved steering Models, use `training hosted-model-version <model-project-id>` to read the verified version. A new neuron experiment retains its compact version/publication/profile pin. Compile through `hosted-compile-modification`; the server resolves that exact source. Off and the original saved profile remain distinct comparison variants. Editing coordinates replaces the intervention; it does not stack profiles. Other experiment types must not silently drop the saved steering source.

`training hosted-saved-model-serving <selection.json>` reads serving state for `{modelProjectId, versionHash}`. `hosted-control-steering-serving <command.json>` sends `{modelProjectId, request}` with the exact version, CAS revision, operation ID, default publication and idle timeout. Activate requires `--yes`; stopping retains cleanup and outstanding-request evidence. A saved version alone does not prove that a compatible runtime is available.

Use `training hosted-import-calibration <input.json>`, `hosted-calibration <id>`, `hosted-calibrations`, and `hosted-archive-calibration <command.json>` for original fixed-calibration custody. Import takes the full original sealed export plus team, nullable Project, name and operation ID. Archive takes `{id, request}` with the retained export hash and record revision. History is metadata only. Reuse the original operation ID and exact request when reconciling an unknown response. Importing a measured artifact proves its retained bytes and scope; runtime qualification is separate. Never construct a fixed calibration from displayed run scales.

When using the Python dense reference SDK with an already loaded supported model, `executor.calibrate(request)` performs one bounded unsteered forward and returns that original export. This is computation; review its model, token, duration and resource bounds before running it. No CLI custody command starts calibration or rents compute implicitly.

### Engram module training

Use `training hosted-engram-capability <query.json> --team-id <id> --json` before preparing an Engram experiment. A source contract or paper configuration does not establish a qualified training or serving runtime. An unavailable capability is an explicit result; do not substitute SFT, Spark rows, activation steering or a LoRA artifact.

Compile the exact base and reviewed supervised batch with `hosted-compile-engram <input.json>`, then use `hosted-prepare-engram <input.json>`. Retain the returned canonical request, operation ID, plan hash, revision and spend cap. Compilation and preparation do not start training. Only `hosted-start-engram <input.json> --yes` authorizes the prepared paid operation. Status/results use `hosted-engram-execution <execution-id>`; history uses `hosted-engram-executions` with project, phase, cursor and limit filters. Cancel through `hosted-cancel-engram <input.json>` using the original execution and current revision; reconcile unknown outcomes before retrying.

`hosted-save-engram-model <input.json>` saves a verified completed result with its exact result/artifact hashes and Model revision. It does not activate serving or prove improvement. The saved version retains the full learned memory module and exact base. Parent continuation selects an exact committed parent artifact and starts a fresh optimizer; it is not an interrupted optimizer/RNG resume. Training controls are learning rate, weight decay, optimizer steps, gradient accumulation, sequence length, seed, duration and checkpoint-byte bounds. Batch size is one and clipping is fixed by the implementation. Qualification, reload equivalence and held-out behavior remain separate evidence.

When continuing from a saved Engram Model, retain the compact `startingModule` pin (Model ID/version hash, artifact ID/content hash and full base model hash) alongside `parentArtifact`. Compile and prepare must preserve that named source; an artifact reference alone does not preserve which saved Model was selected.

Read exact Engram serving state with `training hosted-saved-model-serving <selection.json> --team-id <id> --json`, where the selection is `{modelProjectId, versionHash}`. Use `training hosted-control-engram-serving <command.json> --team-id <id> [--yes] --json` with `{modelProjectId, request}`. The request has schemaVersion `openpond.engramModelServingControlRequest.v1`, teamId, original operationId, exact versionHash, expectedRevision, action `activate` or `stop`, defaultEnabled and idleTimeoutSeconds (60–3600). Activation requires `--yes`; retain the same operation and request when reconciling a lost acknowledgement. This controls the genuine learned module, without an adapter or checkpoint alias. Read capacity, binding, cleanup and outstanding-request evidence before treating Stop as released; a saved module alone does not establish a qualified runtime.

### Typed decision models

Use `training hosted-decision-capability <query.json> --team-id <id> --json`
before preparing decision training or scoring. The exact selected release is
`bespokelabs/Bespoke-Nimble-9B@e93fabce8fcee46e7e8b45e2d955b8a4f0035917`,
including its own tokenizer and chat template. Its separately pinned frozen
backbone is the complete Qwen3.5 conditional-generation model. Never substitute
a dense Qwen3 model, generic chat JSON, sampled answers or partial logprobs.
Current runtime qualification remains unavailable; a source contract or a
successful capability read does not authorize execution or prove readiness.

Compile with `hosted-compile-decision <input.json>`. The input has `method:
"decision_model"`, mode `train` or `score`, workspace, nullable Project, exact
source query and raw `form`. A train form requires an exact reviewed supervised
batch reference and raw training settings; the host resolves and reauthorizes
approved examples/targets. Do not supply unreviewed raw rows as a bypass. A score
form contains `stateJson`, ordered named questions/choices and bounds, without
targets or a training batch. Choice, boolean and integer-level questions retain
their real values. Labels stay outside the model prompt. Compilation grants no
execution authority.

Retain the returned compiled request and its input/form hashes. Prepare through
`hosted-prepare-decision <input.json>` with the same mode/query, stable operation
ID, name, Project, approved spend cap and original `sourceForm` when authored
through the form. The host resolves the actual qualified runtime. Start only
the reviewed plan with `hosted-start-decision <input.json> --yes`; its command
retains the execution ID, operation ID, plan hash, revision and full approved
cap. Read both modes with `hosted-decision-execution <execution-id>` and discover
creator-owned history with `hosted-decision-executions`, following every cursor.
Use `--mode train|score`, `--id`, `--project-id`, `--phase` and `--limit` as needed.
Cancel through `hosted-cancel-decision <input.json>` and retain custody until
cleanup/settlement completes. A result alone does not prove capacity release.

`hosted-save-decision-model <input.json>` accepts only a completed training
result's exact execution/result/artifact hashes, desired name, nullable target
Model and CAS revision. It preserves the genuine decision adapter and original
source request, not a fabricated training Job/checkpoint. Read the exact saved
version with `hosted-model-version <model-project-id> --version-hash <sha256>`;
omitting that option explicitly requests the current version. Saving does not
activate serving or establish measured quality.

Read exact serving state with `hosted-decision-serving <selection.json>`, using
`{modelProjectId, versionHash}`. Control it through
`hosted-control-decision-serving <command.json>` with `{modelProjectId, request}`.
The request uses `openpond.decisionModelServingControlRequest.v1`, workspace,
operation ID, exact version, expected control revision, action `activate` or
`stop`, and idle timeout 60–3600 seconds. Activate requires `--yes`; Stop does
not. Respect active/unsettled requests, shared capacity and retained cleanup
before declaring it released. A `decision:model:<id>` binding is for the typed
decision scorer and must not be used as a generic chat alias.

For an active saved version, `hosted-score-decision <command.json> --yes` accepts
`{modelProjectId, request}`. The request uses
`openpond.decisionModelScoreRequest.v1`, team ID, a stable `requestId`, exact
`versionHash`, `input: {state, questions}` and explicit prompt-token, forward-work
and duration limits. There are no targets or Dataset approval requirements for
this unlabeled inference request. It returns the verified full candidate
distribution, actual model/artifact/runtime pins and completed receipt. T1
softmax probabilities are model outputs, not evidence of empirical calibration.

Use the same configured account, workspace, API origin and OpenPond home for
every operation and reconciliation. Never replace a timed-out mutation with a
new operation ID; retry the exact original command only after reconciling its
state. Scoring similarly retains its original `requestId`, Model/version, input
and bounds. A changed question or bound is a new request. CLI `--yes` records an
explicit paid action; it does not enlarge the user's authorization or budget.

Decision authoring uses the existing `hosted-save-draft`, `hosted-draft` and
`hosted-drafts` commands with `operationType: "decision_model"` and raw
`decisionForm`. To copy settings, read the original draft or retained execution
`sourceForm`, then save a distinct draft with a new draft/operation ID. Preserve
the exact base, parent artifact and compact `startingDecision`/starting-model
pin; do not reconstruct missing authoring from displayed probabilities or
silently follow the latest Model version. Compile/prepare anew after edits;
never reuse an old Start approval for copied settings.

Standalone drafts retain the existing 32 KiB settings limit. The separately
bounded compile/scoring request can accept larger inference state; do not claim
that every permitted runtime payload fits in a saved draft or hide a failed save.

### AlphaEdit and selective neuron training

Use the existing hosted commands and configured account. Read capability first:
`training hosted-alphaedit-capability <query.json>` or
`training hosted-neuron-training-capability <query.json>` with `--team-id` and
`--json`. An unavailable exact-model runtime is a result, never permission to
substitute another base, LoRA, or activation steering.

For either method, use `hosted-compile-<method>` and `hosted-prepare-<method>`
with bounded JSON inputs. Here `<method>` is `alphaedit` or `neuron-training`.
Compilation resolves reviewed Dataset batches and exact source/model settings;
preparation returns the immutable execution, plan, revision and spend cap.
Neither starts paid work. Retain those bytes and the original operation ID.
`hosted-start-<method> <command.json> --yes` starts only that approved plan.
Read canonical status and retained results with `hosted-<method>-execution <id>`;
use `hosted-<method>-executions` for creator-owned history with Project, phase,
ID and cursor filters. Follow every cursor when listing all records.
`hosted-cancel-<method> <command.json>` uses the exact execution/plan/current
revision. On an unknown response, reconcile the original operation before
issuing another one; never start another optimizer to recover an upload ACK.

AlphaEdit edits use reviewed task input `{subject,promptTemplate}` with exactly
one `{}` subject placeholder and a string target. Preservation uses reviewed
`{text}` rows. Approved Dataset instructions remain part of the compiled text.
The result retains actual BF16 matrix replacements and per-layer covariance,
projector and sequential state files. A parent must be the exact compatible
committed AlphaEdit artifact; the next edit uses fresh latent optimization and
retained sequential state. It does not resume an interrupted optimizer. Latent
optimization loss is not post-edit quality evidence. Read `comparisons` for
measured starting/edited/fresh-reload target NLL, preservation next-token KL and
reload-equivalence diagnostics. These scores use the reviewed inputs, not a
held-out evaluation set; preserve a recorded false equivalence result.

Selective neuron training uses a reviewed target batch, named reviewed
background batches and optional reviewed preservation data. Selection preserves
span/statistic, background ratio, gradient example bound and optional exact
layer/neuron coordinates. It optimizes selected `down_proj` columns; its saved
artifact is a true column delta, not a LoRA adapter. A saved neuron patch supports
serving; new training cannot silently discard it or claim optimizer continuation.

`hosted-save-alphaedit-model` and `hosted-save-neuron-training-model` take the
completed result/artifact hashes, original save operation and Model CAS revision.
Saving grants no serving authority. `hosted-alphaedit-serving` and
`hosted-neuron-training-serving` read `{modelProjectId,versionHash}`. Their
`hosted-control-<method>-serving` commands take `{modelProjectId,request}` with
team, operation ID, exact version hash, expected revision, action `activate|stop`
and idle timeout. Activation requires `--yes`; Stop must retain outstanding
request, binding, shared-capacity and cleanup evidence until actually settled.
The installed patch is always the selected weight Model; compare an unmodified
base as a separate explicit source. Runtime and method-quality qualification are
separate from retained artifact identity.

Raw settings can be saved using existing `hosted-save-draft`, `hosted-draft` and
`hosted-drafts`: operation type `alphaedit` uses `alphaEditForm`; operation type
`selective_neuron_training` uses `neuronTrainingForm`. Keep incomplete fields as
strings. A named AlphaEdit parent retains both `startingModel.alphaedit` and
`alphaEditForm.startingModule`, not just its base or tensor artifact.


### Reviewed actual-usage funding

- Read `openpond training hosted-capabilities` before choosing billing. `billingModes` reports whether `actual_usage` can reach preparation; an unavailable mode must not replace an existing qualified reserved-budget workflow. Choose the mode before preparing and retain it through recovery. Never switch modes automatically after a rejected review.
- A compatible training preparation can explicitly request `usageFunding: {"schemaVersion":"openpond.trainingUsageFundingRequest.v1","billingMode":"actual_usage","customerCapUsd":null}`. Null uses eligible credits; a positive canonical six-decimal amount sets the whole-Job limit. It never grants debt.
- Keep `maximumSpendUsd` as the preparation/compiler safety budget required by the current contract. It is distinct from an actual-usage customer limit; do not present it as the latter.
- Review returned `plan.usageQuote`: exact training/environment/storage rates, judge prices, startup and retention rules. Retain the whole receipt. `training hosted-start <receipt.json> --yes` carries its exact `usageQuoteHash`; SDK callers must retain that hash explicitly. Preparing or reading a quote does not start work.
- Serving status may include `usageBilling`. When it is reviewable, approve its exact review with `createManagedServingUsageApproval(review, limit)` and pass the result as `usageApproval` in the normal serving control request. A blank limit uses credits. Inspect unavailable reasons; never manufacture a price or bypass runtime qualification.
- Omitting serving `usageApproval` preserves an existing token-billed contract. Never add a deployment charge to token usage or silently change an accepted activation's terms.
- Treat source/schema availability separately from hosted qualification. Physical cutoff, actual debit, output and cleanup still need real acceptance through the normal hosted API. A saved Model or a successful preparation is insufficient proof.

LoRA is the adapter parameterization for both current SFT and GRPO. For a compatible trained GRPO parent, `parent.adapterMode` selects `shared` (update the existing adapter), `residual_append` (freeze the parent and train a stacked adapter), or `sequential_merge` (merge the parent into a derived backbone before training a new adapter). Preserve the exact parent artifact/checkpoint and rank constraints. Current SFT continuation is unavailable; these are continuation choices rather than new method names.
