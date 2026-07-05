# OpenPond Cloud

OpenPond Cloud provides hosted runtime workspaces for agent development and execution. It lets a local conversation or project move into cloud compute without turning the cloud into the source of truth.

Use OpenPond Cloud when you need remote dependencies, long-running work, cloud-only files, a sharable handoff, or a replayable runtime environment. Keep work local when you only need your current machine, local repo, and local credentials.

## Core Model

- Local project: the repo or folder you are working in from the desktop app, CLI, or TUI.
- OpenPond Project: the cloud-side record that points at source metadata and an `openpond.yaml` manifest.
- Agent: the runnable unit created from a synced Project or SDK-generated manifest.
- Hosted workspace: the cloud environment for a run, chat, replay, or source-editing session.
- Source ref: the git-backed checkpoint, managed through [OpenPond Git](openpond-git.md), that keeps changes preservable and reviewable.

## Workspace Modes

OpenPond separates the model you chat with from the place where code runs.

- Local: chat and edits use the local checkout on your machine.
- Cloud workspace: chat runs inside a hosted OpenPond workspace for cloud-only files, dependencies, handoff, or replayable work.
- Hybrid: keep using the selected model provider, including OpenPond Chat or BYOK, but run file reads, edits, commands, git operations, and preservation against a hosted sandbox.

Hybrid mode is for work that benefits from remote compute or dependencies while preserving the selected model path. Local credentials stay local, and sandbox changes remain remote until you explicitly export, apply, preserve, promote, or merge them.

## Local To Cloud Flow

1. Open a local project.
2. Add or detect `openpond.yaml`.
3. Connect the project to an OpenPond Project.
4. Sync the manifest and source metadata.
5. Create or attach an Agent.
6. Start hosted execution for chat, an action run, a goal, or a replay.
7. Preserve the hosted source when the work is useful.
8. Promote or merge the preserved source only when you are ready.

The local repo remains the place you understand and review the work. OpenPond Cloud adds hosted execution and durable run records.

## What OpenPond Cloud Provides

- Hosted shell and file operations for cloud workspaces.
- Hosted actions from `openpond.yaml` and Agent SDK artifacts.
- Logs, receipts, artifacts, and runtime status.
- Source preservation before publishing or promotion.
- Snapshot and replay flows for reproducible runs.
- Optional app/session attachment so a chat can continue inside the hosted workspace.

## OpenPond Connect

Third-party provider access is handled through [OpenPond Connect](openpond-connect.md). Source code should declare what it needs, but it should not commit raw tokens, OAuth grants, cookies, or provider secrets.

The same principle applies locally: connection state and capability metadata can be used by the app, while provider authorization happens through OpenPond Connect.

## Login Boundary

Local OpenPond use does not require login. OpenPond Cloud, cloud sync, shared credentials, and hosted run history require an OpenPond account because those features create cloud resources.
