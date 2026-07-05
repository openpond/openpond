# OpenPond Public Docs

OpenPond is local-first agentic infrastructure with optional cloud hosting. The desktop app, CLI, TUI, Agent SDK, and OpenPond Cloud are designed to keep agent work inspectable, git-backed, and portable across local and cloud execution.

Start here:

- [OpenPond Cloud](cloud.md): hosted runtime workspaces, Hybrid sandbox edits, handoff, source preservation, and replayable runs.
- [OpenPond Git](openpond-git.md): git-backed source ownership, managed workspaces, commits, sync, and cloud handoff.
- [OpenPond Agent SDK](agent-sdk.md): TypeScript source, generated artifacts, validation, evals, traces, and edit policy for durable agents.
- [Creating durable agents](creating-agents.md): how chat conversations, templates, and existing repos become owned agent code.
- [Goals](goals.md): durable goal state, continuation, budgets, and task orchestration.
- [Model access](model-access.md): OpenPond Chat hosted models, BYOK in desktop, Codex support, and open source model orchestration.
- [OpenPond Connect](openpond-connect.md): OAuth and third-party provider connections through the OpenPond website.
- [Continuous Insights](continuous-insights.md): background analysis of chat logs, runs, errors, and follow-ups.

## Principles

- Local first: you can use OpenPond locally without logging in.
- Source owned: durable agents are backed by code you can inspect, edit, commit, and move.
- Cloud optional: OpenPond Cloud adds hosted execution, syncing, and handoff when you want it.
- Model agnostic: orchestration should work across Codex, BYOK providers, OpenPond-hosted models, and open source models.
- Evidence based: goals, evals, traces, and generated artifacts make agent behavior reviewable instead of opaque.
