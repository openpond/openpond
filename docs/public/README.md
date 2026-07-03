# OpenPond Public Docs

OpenPond is local-first agentic infrastructure with optional cloud hosting. The desktop app, CLI, TUI, Agent SDK, and OpenPond Sandboxes are designed to keep agent work inspectable, git-backed, and portable across local and cloud execution.

Start here:

- [OpenPond Sandboxes](sandboxes.md): hosted runtime workspaces for cloud execution, handoff, source preservation, and replayable runs.
- [OpenPond Agent SDK](agent-sdk.md): TypeScript source, generated artifacts, validation, evals, traces, and edit policy for durable agents.
- [Creating durable agents](creating-agents.md): how chat conversations, templates, and existing repos become owned agent code.
- [Goals](goals.md): durable goal state, continuation, budgets, and task orchestration.
- [Credentials and models](credentials-and-models.md): BYOK model access, Codex support, connector credentials, and local/cloud secret boundaries.
- [Continuous Insights](continuous-insights.md): background analysis of chat logs, runs, errors, and follow-ups.

## Principles

- Local first: you can use OpenPond locally without logging in.
- Source owned: durable agents are backed by code you can inspect, edit, commit, and move.
- Cloud optional: OpenPond Sandboxes add hosted execution, syncing, and handoff when you want them.
- Model agnostic: orchestration should work across Codex, BYOK providers, OpenPond-hosted models, and open source models.
- Evidence based: goals, evals, traces, and generated artifacts make agent behavior reviewable instead of opaque.
