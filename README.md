<div align="center">
  <h1>OpenPond</h1>
  <p><strong>Use your LLM subscription in the cloud without paying API prices.</strong></p>
  <p>
    <a href="https://github.com/openpond/openpond/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/openpond/openpond/actions/workflows/ci.yml/badge.svg" /></a>
    <a href="apps/cli"><img alt="npm package status" src="https://img.shields.io/badge/npm-unpublished-lightgrey?logo=npm&logoColor=white" /></a>
    <img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-000000?logo=bun&logoColor=white" />
    <img alt="Language: TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178c6?logo=typescript&logoColor=white" />
  </p>
</div>


The OpenPond harness lets you use the LLM subscriptions you already pay for while running agent work in hosted sandboxes through [OpenPond Cloud](docs/public/cloud.md).

Keep chat, approvals, model settings, and source review local. Let hosted sandboxes handle file reads, file writes, shell commands, dependency installs, hosted actions, and long-running execution.

- **Use subscription-based models in the cloud:** bring your BYOK providers or LLM subscriptions without defaulting to API-priced hosted model calls.
- **Ship durable agents to teammates:** create git-backed agents from chat, then use them in the desktop app, OpenPond Web, Slack, or Microsoft Teams.
- **Own the source:** agents and skills start in a local profile repo and can sync to OpenPond Cloud when you want cross-device or hosted execution.

No login required for local work. BYOK for any model. First-class Codex support.

## Features

| Product | Capability |
| --- | --- |
| Agents [(docs)](docs/public/creating-agents.md) | Create durable agents from any chat; agent code is saved locally to your profile, with one-click cloud push when you want access from Slack, another computer, or OpenPond Web. |
| BYOK [(docs)](docs/public/model-access.md) | Chat with hosted OpenPond models, BYOK providers in the desktop app, OpenAI Codex, and open source model paths. |
| Insights Agent [(docs)](docs/public/continuous-insights.md) | Run every 5 minutes by default to review your entire setup, track chat logs, runs, errors, and follow-ups, and turn useful work into explicit next steps. |
| Advanced goal loops [(docs)](docs/public/goals.md) | Build composable, bounded task loops with continuation, budgets, and completion evidence; Insights Agent and skill creation both run on this goal system. |
| OpenPond Cloud [(docs)](docs/public/cloud.md) | Move between local projects, hosted workspaces, Hybrid sandbox execution, replayable runs, and cloud compute through [openpond.ai](https://openpond.ai). |
| OpenPond Connect [(docs)](docs/public/openpond-connect.md) | Connect Google Drive, Twitter/X, Slack, docs, calendars, and other provider-backed systems through [openpond.ai](https://openpond.ai) without committing secrets. |

## More Features

- Skill creation for reusable profile-backed behavior and project-specific workflows.
- Auto compaction to keep long-running work moving without losing important context.
- YOLO mode for trusted workspaces where explicit approval prompts should not slow down execution.
- Full-featured sidebar for projects, chats, cloud workspaces, agents, history, and workspace state.
- In-app browser with browser control for visible web navigation, inspection, clicking, typing, and scrolling.
- Side chats for branching into focused work without losing the main conversation.
- Server mode for running OpenPond as a local app-layer daemon.
- TUI and CLI modes for terminal-first workflows.
- Connected apps and provider mentions for bringing external context into chats and agents.
- Workspace diff review, file inspection, and source preservation before cloud promotion.
- Sandbox templates, hosted actions, snapshots, replays, and scheduled runs.
- Approval policies, sandbox controls, usage tracking, and goal budgets for bounded agent execution.

## Agents & Skills

OpenPond agents and skills start local by default. When you create one from chat, OpenPond writes it into your active profile repo as ordinary source files, keeps it git-backed, and updates the profile catalog so the desktop app, CLI, TUI, and local chats can discover it.

Agents are full source packages for durable workflows: code, actions, instructions, evals, generated OpenPond artifacts, and setup requirements. Skills are lighter reusable instruction packages. A profile skill is intentionally just a `SKILL.md`; if the workflow needs code, tools, scripts, fixtures, or evals, make it an agent instead.

Sync the same profile repo with [OpenPond Cloud](docs/public/cloud.md) when you want it to work everywhere: OpenPond Web, another computer, hosted sandboxes, Slack, or Microsoft Teams can all run against the same git-backed source instead of a hidden chat transcript.

A profile package might look like this:

```text
openpond-profile.json
profiles/
  default/
    settings/
      profile.yaml
    agents/
      customer-support-tracker/
        package.json
        agent/
          agent.ts
          actions.ts
          instructions.md
          workflows/
            chat.ts
          evals/
            basic.eval.ts
        .openpond/
          agent-manifest.json
          action-registry.json
          agent-inspect.json
    skills/
      release-notes/
        SKILL.md
```

See [Creating durable agents](docs/public/creating-agents.md), [Agent SDK](docs/public/agent-sdk.md), and [OpenPond Git](docs/public/openpond-git.md) for the deeper contract.

## Local <> Cloud

OpenPond lets you keep the harness local without forcing the work to run on your laptop. In local mode, the desktop app owns the chat, approvals, BYOK provider settings, and source review, while [OpenPond Cloud](docs/public/cloud.md) can provide the sandbox where execution actually happens.

Think of it as local control with cloud hands. Your configured model path or LLM subscription can drive the agent, but file reads, file writes, shell commands, dependency installs, hosted actions, and long-running work happen inside an OpenPond sandbox. Your local workspace stays reviewable, and the sandbox gives the agent a clean environment built for replay, preservation, and handoff.

That split is useful when a teammate needs an agent in Slack, Microsoft Teams, OpenPond Web, or another machine: the same git-backed source and profile catalog can sync to the cloud, then run in hosted infrastructure without requiring the teammate to clone the repo, install dependencies, or understand the local setup.

## Quick Start

Prerequisites:

- Bun
- Node.js `>=20.19 <21` or `>=22.12`

Install dependencies and start the local app:

```bash
bun install
bun run dev
```

`bun run dev` launches the desktop development flow. If an app is already running, keep using the existing process instead of starting another one.

## Common Commands

```bash
bun run dev                 # run the desktop development app
bun run dev:web             # run the browser app flow
bun run cli                 # run the CLI entrypoint
bun run terminal            # run the terminal chat client
bun run typecheck           # TypeScript project references
bun run build               # typecheck, bundle server, and build web
bun run test                # unit, CLI, and agent SDK test suites
bun run budgets:warn        # performance budget checks
bun run cli:pack:dry-run    # inspect the CLI npm package contents
bun run agent-sdk:check     # SDK build, tests, examples, hygiene, and pack checks
```

## Repository Layout

```text
apps/
  cli/       # openpond/op command and TUI entrypoint
  desktop/   # Electron shell
  server/    # local app-layer daemon
  terminal/  # server-attached terminal UI
  web/       # shared renderer for desktop and browser mode
packages/
  agent-sdk/       # TypeScript-first agent SDK, templates, examples, evals
  cloud/           # cloud profile and hosted-workspace helpers
  codex-provider/  # Codex provider integration
  contracts/       # shared runtime, app, profile, and workspace contracts
  runtime/         # chat/runtime primitives
packaging/
  homebrew/        # draft Homebrew cask
  winget/          # draft winget manifests
tests/             # root unit and integration-style tests
```

## Development Flow

The root workspace is the source of truth for cross-package work. Prefer root commands when changing shared behavior, and package-local commands when iterating on a focused area.

| Area | Command |
| --- | --- |
| Full local app | `bun run dev` |
| Browser renderer | `bun run dev:web` |
| CLI package | `bun run cli`, `bun run cli:typecheck`, `bun run cli:test` |
| Agent SDK | `bun run agent-sdk:typecheck`, `bun run agent-sdk:check` |
| Server build | `bun run build:server` |
| Desktop packaging | `bun run package:linux`, `bun run package:mac`, `bun run package:win` |

## Quality Gates

CI installs with Bun, then runs:

```bash
bun run typecheck
bun run build
bun run budgets:warn
bun run test
```

Coverage badges should be added only after coverage is collected and uploaded by CI. Until then, the CI badge is the accurate project health signal.

## Publishing Notes

The CLI package lives in `apps/cli` and is configured as the public npm package `openpond` with the `openpond` and `op` binaries. The npm badge above is marked unpublished until the package is available in the public registry.
