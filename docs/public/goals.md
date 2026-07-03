# Goals

Goals are durable task state for agentic work. They let a user define an objective once, then let OpenPond track status, continuation, budget, context, and completion evidence across turns.

Goals are control-plane state, not prompt decoration. The runtime owns lifecycle transitions such as pause, resume, clear, budget limits, and continuation. The model can contribute progress and completion evidence, but it should not secretly rewrite the user's goal.

## Commands

```text
/goal <objective>
/goal
/goal status
/goal pause
/goal resume
/goal clear
```

`/goal <objective>` sets or replaces the active objective for the session. `/goal status` shows current state. `/goal pause` stops automatic continuation without deleting the goal. `/goal resume` continues. `/goal clear` removes the goal.

## Goal States

- `active`: continuation may run.
- `paused`: the goal is retained, but automatic continuation is stopped.
- `budget_limited`: the runtime stopped because the configured token, turn, or time budget was reached.
- `complete`: the objective has been achieved and verified.
- `blocked`: progress cannot continue productively without user input or an external change.

## How Goals Work

1. The user creates a goal.
2. OpenPond stores the goal with the session.
3. The runtime supplies the current goal as structured context.
4. The agent works toward the next concrete step.
5. The runtime records progress, usage, and relevant context.
6. Before completion, the agent audits evidence such as files, tests, diffs, command output, artifacts, or deployment state.
7. The goal is marked complete only when the objective is actually satisfied.

## Local And Cloud

Goals work as part of the local-first app experience. A goal can operate on local projects, Codex-backed sessions, OpenPond-hosted chat, and Sandbox workspaces depending on the selected provider and workspace.

OpenPond Sandboxes are useful for goals that need cloud dependencies, long-running execution, replayable state, or source preservation. Local goals remain useful when the task only needs the user's machine and repo.

## Budgeting And Safety

Budgets keep goals bounded. User messages take priority over automatic continuation, and OpenPond should avoid empty continuation loops. If the agent cannot make real progress, it should report the blocker instead of repeatedly spending turns.
