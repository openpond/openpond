# Datasets, experiments, and training

Use this guidance when the user asks to create or inspect a dataset, author a grader, run or improve an experiment, train a model, or learn from selected logs. The CLI is the execution interface. Guide the conversation and return useful inline UI through the available host; the app owns persisted resource attachment and the compact bar.

## Work from the conversation

Treat ordinary requests such as “check this dataset,” “edit these examples,” or “run this grader” as enough to begin. Resolve the referenced resource from the current conversation and attached experiment, read what you need, and do the requested work. Keep command syntax, executor names, invocation context, and internal IDs out of conversational replies unless they help diagnose an error or the user asks for them. The user does not need to tell you to load this skill or call a particular tool.

Use [Compact inline resource presentation](compact-resource-tables.md) as guidance, not a required template. The bottom composer bar is the persistent place to inspect and act on the attached resources. Give a brief inline summary; use a small HTML card or table only when useful to this request. Do not automatically print every dataset, repeat the bar, or build an all-resources tabbed dashboard. Keep useful actions visible and secondary actions in an overflow menu. A card showing a started experiment complements its canonical attachment in the bar. Let the content and layout fit the work.

- Inspect the current experiment and linked dataset when the app supplies their references. Otherwise discover existing resources before asking whether to reuse or create one. Ask only for choices that materially affect the work and cannot be inferred from the request or existing context.
- A dataset can be authored without a model, Profile, cloud account, or executed experiment. If the app provides a draft experiment scope, keep working in it; do not launch a run merely to give the UI an experiment ID.
- Several datasets and runs can belong to a conversation. Use explicit IDs and revisions for operations; inspecting a candidate must not silently replace a baseline or alter another run's saved inputs.
- Keep dataset creation and grader creation distinct. A request to add a grader applies to the selected dataset unless the user asks to create another dataset.

## Discovery and inline selection

For “list my datasets” or similar discovery, use the scoped CLI. Local discovery uses `"$OPENPOND_CLI_NODE" "$OPENPOND_CLI_ENTRY" datasets list --local --json`; omitting `--local` selects the hosted/team command family. Discovery opens dataset focus without creating an experiment, selecting a returned dataset, or starting compute. Dataset-only focus has no experiment number. The bar’s New experiment action expands dataset/grader selection below the fixed top row and creates an experiment only when the user confirms the configuration. Reuse an existing experiment when the request concerns it. Keep the response bounded and relevant: a short summary usually suffices; a compact selectable table is useful when the user needs to choose among records. Do not attach all discovery results. For a specific dataset, read that resource through the CLI so its canonical reference attaches. Inspect `datasets context --local --json` if the bar or selection appears missing, and surface attachment failures instead of claiming selection succeeded.

For a published OpenPond HTML picker, render Select buttons with `data-openpond-resource-kind="dataset"`, `data-openpond-resource-id="<exact-id>"`, and `data-openpond-resource-revision="<revision>"`; experiments use kind `experiment`. The host validates a real click, selects the resource, collapses the picker with Change, and queues a canonical selection message. Keep this presentation compact and use a saved-record table. Do not add scripts that call APIs or manufacture selection messages.

Use the host's existing selection interaction with exact resource references. When the user selects a record, use the available shared attach/select connection, collapse the picker to a reopenable receipt when supported, and continue the conversation. Preserve unsent composer text. Selecting data alone does not run an experiment or train a model. If the host lacks interactive selection or attachment, return concise references and accept a conversational choice without pretending the UI updated.

Inspect related experiments and graders after selection and summarize what matters to the user's objective. Distinguish running jobs from all related experiments, and graders on the selected revision from graders pinned to old runs. Use real counts; do not repeat invented example numbers. Suggest an appropriate next action without enforcing a setup wizard. Quiet bottom-bar selection need not trigger another assistant response.

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

Use `datasets context --local --json` to inspect the current scope; `datasets select <id> --local --expected-revision <revision>` selects an existing dataset. `datasets new-experiment --local --operation-id <stable-id>` creates a configuration scope without compute. Scope selection/rename use `select-experiment` and `rename-experiment`; check their current help. These commands require app-supplied context. Mere `datasets list` discovery does not attach all records.

Use the application's supplied local server context and OpenPond home when present. Pass that home with `--home`; the standard development desktop uses `~/.openpond/openpond-app-dev`. Check this context before diagnosing missing authentication. Do not guess a second installation, scrape credentials, or switch teams to get an operation to succeed. Local dataset commands use `--local`; hosted operations have their own explicit destination/account options. Local experiment execution may still call a paid remote inference provider.

For Diagnose, Improve, or grader repair, read [Diagnose and improve](diagnose-and-improve.md).

## Dataset and grader work

Use the bundled openpond-taskset-authoring skill for deeper task design, split isolation, provenance, and grader calibration. Inspect source schemas and representative examples before importing or mapping data. Preserve source provenance and save useful drafts even when validation is incomplete. Read the supported dataset schema before authoring an unfamiliar request.

Test graders against meaningful known-good and known-bad examples before claiming they are qualified. Distinguish saved data, structural validation, grader checks, and model performance. Editing a grader creates new evidence; it does not retroactively change the original experiment result.

## Experiments and improvements

Discover available models before selecting an evaluated model. In a scoped chat, persist the explicit choice with `openpond datasets select-model <providerId/modelId> --local --json` using an exact entry from `openpond experiments models --local --json`. Read the current selection with `openpond datasets context --local --json`; `evaluationModel` is the evaluation target. A user-named model overrides that saved choice once resolved to an available catalog entry; ambiguous names need clarification. Do not substitute the chat model or another provider when the chosen model is unavailable. The agent answering this chat and the model under evaluation are separate choices. Pin the dataset revision and grader configuration; use a stable operation identity for replay where supported. Reconcile an uncertain submission before issuing a new run.

Use existing authorized limits. Ask for a missing spending ceiling when the selected operation requires one. A subscription run with unavailable dollar accounting must not be described as costing zero.

Inspect status, results, coverage, and failed cases before claiming success or proposing an improvement. Report pass rate only when the grader defines pass/fail; otherwise report the actual score. Compare matched inputs when making improvement claims, and identify changed-input comparisons.

Use the resource-specific Diagnose/Improve guidance above. The older source-component improvement API is not the general chat improvement path.

## Composer actions

Resource selection changes the attached context without sending a message. New experiment opens the connected setup rows below the bar and creates a configuration only on confirmation. View rows reads the selected dataset in that area. New dataset and Create grader open small description forms; their explicitly labeled draft buttons append a request with exact references. Improve and run requests draft chat text. Preserve existing unsent text. The expand/collapse control hides setup without changing the resource selection.

The Train on OpenPond action prepares a hosted-training request, not a generic improvement or an immediate job submission. Use the official hosted training capabilities and preparation commands, inspect model/data compatibility, and present the plan and cost before starting. Serving/deploying a resulting model is a separate operation from training; do not silently substitute local training, Profile edits, or deployment.

## Training and continual learning

Discover the supported model, recipe, execution destination, and training-data requirements. Reuse existing projects and preparation receipts where appropriate. Evaluation evidence is not automatically approved training data, and frozen evaluation examples must retain their evaluation role.

Use the current CLI's prepare/start/status/watch/artifacts operations for the selected backend. Return retained job/model references and read saved completion state; a submitted job is not a trained model. CLI flags that acknowledge submission do not create user authorization or enlarge a budget.

For learning from logs, resolve the selected sources and the requested recurrence and budget. Inspect `openpond continual` capabilities before promising unattended scheduling; a manifest run is not proof of an enabled background learning policy. Importing or syncing logs alone does not enable training.

## Chat resource attachment

Preserve app-provided execution context. Use supported CLI attachment/context behavior when the installed runtime supplies it; do not invent session flags, set another chat's identity, or parse human-facing terminal decorations into resource records.

Include the exact returned resource IDs, revisions, and status in the result when useful. The app should attach and track these through its server-owned resource events. Until that integration is available, report the saved references honestly; do not claim the bottom bar updated or that a resource was attached solely because a CLI command succeeded.

### Retained training jobs in chat

When the app supplies scoped CLI context, local training start/status and hosted start/submit/status commands retain the canonical job in the originating experiment scope. Local jobs keep their Model Run, model/version and artifact lineage; hosted jobs keep their API origin, workspace and hosted Model Project identity. These are training references, not graded evaluations. Inspect a saved job with the matching local or hosted status command to refresh it; do not submit a replacement because chat attachment failed. Hosted commands outside the app remain standalone. Never infer a trained model or successful artifact from a running job, and use the existing artifact/receipt commands before claiming training produced usable output.

### State-aware actions

The bar has one primary action based on retained run evidence and the selected configuration: New experiment, Set up, Run, Run updated, View progress, Improve, or Retry. Dataset/workspace or model changes require fresh evaluation evidence; an unchanged completed run leads to result and coverage analysis. Improve makes a targeted change, validates it, and evaluates it within the authorized scope; it does not automatically train or deploy a model. Repeat run is an explicit overflow action and always creates separate evidence after reconciling uncertain submissions.

The independent chat experiment runner currently evaluates all graders in the selected dataset revision. Selecting one grader in the bar is an inspection/test focus, not a run filter. This runner does not expose saved-answer regrading through the independent CLI route; do not claim that it does or repurpose grader fixture tests as experiment results. Team-owned scoring has its own CLI operations and authority. The independent bar uses Run updated for changed graders until compatible scoring is exposed for that owner.

Setup and row inspection stay in the controls. Execution and improvement actions show a compact request preview, then append an unsent request with exact dataset, retained run, grader, and evaluation-model references. Opening an action never sends it. Train prepares hosted training on OpenPond and keeps serving/deployment separate. Dataset discovery still requires no numbered experiment.


### Execution destination

The experiment remembers executionLocation (local or cloud), independently of evaluationModel. Read it with datasets context; use datasets select-destination local|hosted --local --json through the scoped executor for an explicit conversational choice. Prefer the destination pinned to the current draft over later scope changes. Local is the default for new working data and configurations. An existing hosted record retains its owning backend.

For independent installation datasets, experiments run --local orchestrates locally; experiments run-cloud --local requests hosted execution through the local app bridge and publishes the required version using the existing owner. Hosted execution supports available OpenPond models, not Codex subscription models. Team/Profile resources have separate capability and ownership rules: inspect those commands and report an unsupported combination instead of moving the resource or guessing a fallback. Merely choosing Hosted does not upload data or run anything.

Train prepares hosted training separately from this evaluation setting. Inspect supported preparation and publishing commands, upload only the required saved assets, and retain the local source and upload lineage.
