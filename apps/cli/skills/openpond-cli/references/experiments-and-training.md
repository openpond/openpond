# Datasets, experiments, and training

Use this guidance when the user asks to create or inspect a dataset, author a grader, run or improve an experiment, train a model, or learn from selected logs. The CLI is the execution interface. Guide the conversation and return useful inline UI through the available host; the app owns persisted resource attachment and the Training picker and resource sidebar.

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

For “list my datasets” or similar discovery, use the scoped CLI. Local discovery uses `"$OPENPOND_CLI_NODE" "$OPENPOND_CLI_ENTRY" datasets list --local --json`; omitting `--local` selects the hosted/team command family. Discovery opens dataset focus without creating an experiment, selecting a returned dataset, or starting compute. Dataset-only focus has no experiment number. The composer’s Training picker selects Experiment or Model. Under Experiment, New experiment… opens a dataset chooser; confirming creates a configuration without compute. The right sidebar holds its inputs, results and training controls. Reuse an existing experiment when the request concerns it. Keep the response bounded and relevant: a short summary usually suffices; a compact selectable table is useful when the user needs to choose among records. Do not attach all discovery results. For a specific dataset, read that resource through the CLI so its canonical reference attaches. Inspect `datasets context --local --json` if the saved selection appears missing, and surface attachment failures instead of claiming selection succeeded.

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

Use the application's supplied local server context and OpenPond home when present. Pass that home with `--home`; the standard development desktop uses `~/.openpond/openpond-app-dev`. Check this context before diagnosing missing authentication. Do not guess a second installation, scrape credentials, or switch teams to get an operation to succeed. Local dataset commands use `--local`; hosted operations have their own explicit destination/account options. Local experiment execution may still call a paid remote inference provider.

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
