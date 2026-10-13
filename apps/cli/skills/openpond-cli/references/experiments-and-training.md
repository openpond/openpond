# Datasets, experiments, and training

Use this guidance when the user asks to create or inspect a dataset, author a grader, run or improve an experiment, train a model, or learn from selected logs. The CLI is the execution interface. Guide the conversation and return useful inline UI through the available host; the app owns persisted resource attachment and the compact bar.

## Work from the conversation

Treat ordinary requests such as “check this dataset,” “edit these examples,” or “run this grader” as enough to begin. Resolve the referenced resource from the current conversation and attached experiment, read what you need, and do the requested work. Keep command syntax, executor names, invocation context, and internal IDs out of conversational replies unless they help diagnose an error or the user asks for them. The user does not need to tell you to load this skill or call a particular tool.

Use inline HTML for dataset browsing, example inspection, grader checks, and results when a visual makes the answer easier to use. Publish it through the host's existing HTML preview/render tools as part of the response doing that work. Keep a brief explanation alongside it; do not repeat the same inventory or results as a long bullet list. An edit can update the dataset and show the changed examples in that response's HTML. Do not create a separate conversation or a permanent panel just to display it. Use short conversational action text such as “Check this dataset” or “Test this grader”; exact resource references belong in the host's structured context.

- Inspect the current experiment and linked dataset when the app supplies their references. Otherwise discover existing resources before asking whether to reuse or create one. Ask only for choices that materially affect the work and cannot be inferred from the request or existing context.
- A dataset can be authored without a model, Profile, cloud account, or executed experiment. If the app provides a draft experiment scope, keep working in it; do not launch a run merely to give the UI an experiment ID.
- Several datasets and runs can belong to a conversation. Use explicit IDs and revisions for operations; inspecting a candidate must not silently replace a baseline or alter another run's saved inputs.
- Keep dataset creation and grader creation distinct. A request to add a grader applies to the selected dataset unless the user asks to create another dataset.

## Discovery and inline selection

For “list my datasets” or similar discovery, read existing resources and return a compact selectable HTML table using the host's inline UI capabilities. Show names, versions, and enough local/hosted context to distinguish records. Keep long collections bounded; fetch more when requested rather than loading every dataset's contents. Do not attach all discovery results.

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
| Qualified source-component improvement | `openpond improve` |
| Model projects, training preparation/execution, status, and artifacts | `openpond training` |
| Supported continual experiment manifests and reports | `openpond continual` |

When the app provides a scoped command executor, run the CLI with `"$OPENPOND_CLI_NODE" "$OPENPOND_CLI_ENTRY"` as its prefix (`openpond_exec_command` for native agents; the existing `exec_command` for hosted chat). This uses the app's bundled installation and attaches saved results to the originating chat. Do not use the provider's unrelated shell for these workflows or copy invocation credentials into arguments.

Use `datasets context --local --json` to inspect the current scope; `datasets select <id> --local --expected-revision <revision>` selects an existing dataset. `datasets new-experiment --local --operation-id <stable-id>` creates a configuration scope without compute. Scope selection/rename use `select-experiment` and `rename-experiment`; check their current help. These commands require app-supplied context. Mere `datasets list` discovery does not attach all records.

Use the application's supplied local server context and OpenPond home when present. Pass that home with `--home`; the standard development desktop uses `~/.openpond/openpond-app-dev`. Check this context before diagnosing missing authentication. Do not guess a second installation, scrape credentials, or switch teams to get an operation to succeed. Local dataset commands use `--local`; hosted operations have their own explicit destination/account options. Local experiment execution may still call a paid remote inference provider.

## Dataset and grader work

Inspect source schemas and representative examples before importing or mapping data. Preserve source provenance and save useful drafts even when validation is incomplete. Read the supported dataset schema before authoring an unfamiliar request.

Test graders against meaningful known-good and known-bad examples before claiming they are qualified. Distinguish saved data, structural validation, grader checks, and model performance. Editing a grader creates new evidence; it does not retroactively change the original experiment result.

## Experiments and improvements

Discover available models before selecting an evaluated model. The agent answering this chat and the model under evaluation are separate choices. Pin the dataset revision and grader configuration; use a stable operation identity for replay where supported. Reconcile an uncertain submission before issuing a new run.

Use existing authorized limits. Ask for a missing spending ceiling when the selected operation requires one. A subscription run with unavailable dollar accounting must not be described as costing zero.

Inspect status, results, coverage, and failed cases before claiming success or proposing an improvement. Report pass rate only when the grader defines pass/fail; otherwise report the actual score. Compare matched inputs when making improvement claims, and identify changed-input comparisons.

`openpond improve` is the qualified source-component lifecycle. Inspect its eligible options; it is not a universal model-training command. For a model-only experiment, use failure analysis, another supported evaluation, or training preparation as appropriate to the user's objective. Applying a tested Profile component is separate from creating or testing it.

## Training and continual learning

Discover the supported model, recipe, execution destination, and training-data requirements. Reuse existing projects and preparation receipts where appropriate. Evaluation evidence is not automatically approved training data, and frozen evaluation examples must retain their evaluation role.

Use the current CLI's prepare/start/status/watch/artifacts operations for the selected backend. Return retained job/model references and read saved completion state; a submitted job is not a trained model. CLI flags that acknowledge submission do not create user authorization or enlarge a budget.

For learning from logs, resolve the selected sources and the requested recurrence and budget. Inspect `openpond continual` capabilities before promising unattended scheduling; a manifest run is not proof of an enabled background learning policy. Importing or syncing logs alone does not enable training.

## Chat resource attachment

Preserve app-provided execution context. Use supported CLI attachment/context behavior when the installed runtime supplies it; do not invent session flags, set another chat's identity, or parse human-facing terminal decorations into resource records.

Include the exact returned resource IDs, revisions, and status in the result when useful. The app should attach and track these through its server-owned resource events. Until that integration is available, report the saved references honestly; do not claim the bottom bar updated or that a resource was attached solely because a CLI command succeeded.
