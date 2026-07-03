# OpenPond Sandboxes

OpenPond Sandboxes are hosted runtime workspaces for agent development and execution. They let a local conversation or project move into cloud compute without turning the cloud into the source of truth.

Use a Sandbox when you need remote dependencies, long-running work, cloud-only files, a sharable handoff, or a replayable runtime environment. Keep work local when you only need your current machine, local repo, and local credentials.

## Core Model

- Local project: the repo or folder you are working in from the desktop app, CLI, or TUI.
- OpenPond Project: the cloud-side record that points at source metadata and an `openpond.yaml` manifest.
- Agent: the runnable unit created from a synced Project or SDK-generated manifest.
- Sandbox: the hosted runtime for a run, chat, replay, or source-editing session.
- Source ref: the git-backed checkpoint that keeps changes preservable and reviewable.

## Local To Cloud Flow

1. Open a local project.
2. Add or detect `openpond.yaml`.
3. Connect the project to an OpenPond Project.
4. Sync the manifest and source metadata.
5. Create or attach an Agent.
6. Start a Sandbox for chat, an action run, a goal, or a replay.
7. Preserve the Sandbox source when the work is useful.
8. Promote or merge the preserved source only when you are ready.

The local repo remains the place you understand and review the work. The Sandbox adds hosted execution and durable run records.

## What Sandboxes Provide

- Hosted shell and file operations for cloud workspaces.
- Sandbox actions from `openpond.yaml` and Agent SDK artifacts.
- Logs, receipts, artifacts, and runtime status.
- Source preservation before publishing or promotion.
- Snapshot and replay flows for reproducible runs.
- Optional app/session attachment so a chat can continue inside the hosted workspace.

## Credentials

Sandbox credentials are injected as bindings or secret refs. Source code should declare what it needs, but it should not commit raw tokens, OAuth grants, cookies, or provider secrets.

The same principle applies locally: local secrets stay in local settings or environment-backed storage, and cloud secrets stay in OpenPond-controlled bindings.

## Login Boundary

Local OpenPond use does not require login. OpenPond Sandboxes, cloud sync, shared credentials, and hosted run history require an OpenPond account because those features create cloud resources.
