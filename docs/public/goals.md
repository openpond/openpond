# Goals

Goal mode is a Codex-native feature. OpenPond preserves Codex Goal commands, events, history recovery, and compact status presentation, but it does not implement a separate Goal runtime.

## Availability

`/goal` is available only when the selected provider is Codex. The composer hides it for other providers, and a directly typed `/goal` on a non-Codex provider is rejected before the model is invoked.

OpenPond does not provide `/goal-local`, `/goal-remote`, a top-level `openpond goal` CLI command, hosted Goal continuation, or local Goal persistence.

## Behavior

OpenPond passes the complete `/goal ...` command to Codex unchanged. Codex remains responsible for the objective, lifecycle, continuation, budgets, completion, and supported command forms.

OpenPond bridges Codex-native Goal updates into the app so the current status, elapsed time, budget information when supplied, completion state, and Goal details remain visible. Codex history can also restore that presentation when a task is reopened.

Normal OpenPond-hosted turns and subagents remain available without Goal mode. Subagents belong to their parent task and keep their ordinary progress, review, messaging, and cleanup lifecycle.
