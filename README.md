<div align="center">
  <h1>OpenPond</h1>
  <p><strong>Open source. Built for multiplayer.</strong></p>
  <p>
    <a href="https://github.com/openpond/openpond/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/openpond/openpond/actions/workflows/ci.yml/badge.svg" /></a>
    <a href="https://www.npmjs.com/package/openpond"><img alt="npm package version" src="https://img.shields.io/npm/v/openpond?logo=npm&logoColor=white" /></a>
    <img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-000000?logo=bun&logoColor=white" />
    <img alt="Language: TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178c6?logo=typescript&logoColor=white" />
  </p>
</div>

OpenPond is the open-source agent harness for teams. It turns conversations into durable agents, shared workflows, and training-ready Tasksets across whatever model path you want: BYOK providers, hosted OpenPond models, open source models, or the LLM subscriptions you already pay for.

It gives people and agents one source-owned runtime for chats, subagents, skills, goal loops, approvals, connected apps, training evidence, and hosted sandboxes. Keep chat control, model settings, approvals, and source review local; send execution to [OpenPond Cloud](docs/public/cloud.md) when work needs clean compute, long-running processes, replayable runs, or teammate handoff.

- **Model agnostic by design:** route work through Codex, BYOK providers, hosted models, open source models, or subscription-backed model access without locking the agent to one vendor.
- **Frontier-grade orchestration:** coordinate agents, subagents, tools, goals, approvals, browser control, connected apps, and sandbox execution as one inspectable workflow.
- **Source-owned by default:** agents and skills start as ordinary files in a local profile repo, then sync to OpenPond Cloud when you want cross-device or hosted execution.
- **Local control, cloud execution:** review prompts, diffs, settings, and approvals locally while hosted sandboxes handle file reads, file writes, shell commands, dependency installs, actions, and long-running work.
- **Built for teams:** share Team Chat, agents, projects, sandboxes, usage, and member limits without sharing Personal accounts or rebuilding a developer's local setup.
- **Training from real work:** select useful chats, turn them into verifiable Tasksets, run baselines and graders, and prepare bundles for local or configured training destinations.

No login required for local work. Bring your own keys, models, providers, subscriptions, and runtimes. First-class Codex support.

## Features

| Product | Capability |
| --- | --- |
| Desktop, CLI, and TUI | Use the same local runtime through [Desktop](docs/public/desktop.md), the [CLI](docs/public/cli.md), or the [terminal UI](docs/public/tui.md). |
| Orchestration | Run chats, agents, subagents, skills, tools, approvals, browser control, connected apps, and goal loops through one durable execution harness. |
| Model access [(docs)](docs/public/model-access.md) | Bring Codex, BYOK providers, hosted OpenPond models, open source models, or subscription-backed model access to the same agent workflow. |
| Agents [(docs)](docs/public/creating-agents.md) | Create durable agents from any chat; agent code is saved locally to your profile, with one-click cloud push when you want access from Slack, another computer, or OpenPond Web. |
| Teams | Chat with people and agents in one workspace, then share agents, projects, cloud sandboxes, usage policy, and per-member limits through one Team account. |
| Training | Turn selected chats into source-backed Tasksets with explicit tasks, verifiers, splits, baselines, graders, and portable training bundles. |
| Goal loops [(docs)](docs/public/goals.md) | Build composable, bounded task loops with continuation, budgets, completion evidence, and explicit stop conditions for long-running work. |
| Insights Agent [(docs)](docs/public/continuous-insights.md) | Run every 5 minutes by default to review your entire setup, track chat logs, runs, errors, and follow-ups, and turn useful work into explicit next steps. |
| OpenPond Cloud [(docs)](docs/public/cloud.md) | Move between local projects, hosted workspaces, Hybrid sandbox execution, replayable runs, and cloud compute through [openpond.ai](https://openpond.ai). |
| OpenPond Connect [(docs)](docs/public/openpond-connect.md) | Connect Google Drive, Twitter/X, Slack, docs, calendars, and other provider-backed systems through [openpond.ai](https://openpond.ai) without committing secrets. |

## More Features

- Subagent orchestration for splitting work across focused executors with their own context, tools, continuation state, and evidence.
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

Agents are full source packages for durable workflows: code, actions, instructions, evals, generated OpenPond artifacts, and setup requirements. They can call tools, coordinate subagents, run goal loops, and move between local and hosted execution without becoming hidden chat state. Skills are lighter reusable instruction packages. A profile skill is intentionally just a `SKILL.md`; if the workflow needs code, tools, scripts, fixtures, or evals, make it an agent instead.

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

## Training From Real Work

OpenPond treats conversations as evidence, not automatically as training data. From any useful chat, use `Add to training` or `/train` to select the conversations that demonstrate a repeatable job. The training workbench helps turn those sources into a reviewable Taskset with explicit tasks, validation and frozen-eval splits, verifiers, graders, and expected outcomes.

Tasksets live as ordinary source inside the active profile. You can inspect and edit them, run baselines, compare model attempts, review grading evidence, and build a portable training bundle for a local or configured destination. This makes RFT and RL experimentation part of the same development loop as the agent itself:

```text
chat with models and subagents
-> select useful conversations
-> create and review a verifiable Taskset
-> run baselines and grade attempts
-> export or hand off a training bundle
-> bring the improved model back to the same harness
```

The goal is not to train indiscriminately on chat history. It is to turn proven team workflows into inspectable evaluations and high-signal training inputs.

## Local <> Cloud

OpenPond lets you keep orchestration local without forcing execution to run on your laptop. In local mode, the desktop app owns the chat, approvals, model and provider settings, subagent placement, and source review, while [OpenPond Cloud](docs/public/cloud.md) can provide the sandbox where execution actually happens.

Think of it as local control with cloud execution. Your configured model path, BYOK provider, open source runtime, Codex session, or LLM subscription can drive the agent, while file reads, file writes, shell commands, dependency installs, hosted actions, and long-running work happen inside an OpenPond sandbox. Your local workspace stays reviewable, and the sandbox gives the agent a clean environment built for replay, preservation, and handoff.

That split is useful when a teammate needs an agent in Team Chat, Slack, Microsoft Teams, OpenPond Web, or another machine: the same git-backed source, Tasksets, and profile catalog can sync to the cloud, then run in hosted infrastructure without requiring the teammate to clone the repo, install dependencies, or understand the local setup.

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
bun run dev:web             # run watched local server plus browser renderer
bun run dev:web:renderer    # run only the browser renderer
bun run cli                 # run the CLI entrypoint
bun run terminal            # run the terminal chat client
bun run typecheck           # TypeScript project references
bun run build               # typecheck and build server, web, and desktop artifacts
bun run test                # unit, integration, contract, and release smoke suites
bun run test:unit           # fast isolated root and CLI tests
bun run test:integration    # process, training, and sandbox integration tests
bun run test:contract       # compiled server and Agent SDK contracts
bun run test:release        # installed CLI artifact smoke tests
bun run verify:push         # complete local equivalent of the required CI gate
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
packaging/         # active platform policy and release notes
tests/             # root unit and integration-style tests
```

## Development Flow

The root workspace is the source of truth for cross-package work. Prefer root commands when changing shared behavior, and package-local commands when iterating on a focused area.

| Area | Command |
| --- | --- |
| Full local app | `bun run dev` |
| Browser app | `bun run dev:web` |
| Renderer only | `bun run dev:web:renderer` |
| CLI package | `bun run cli`, `bun run cli:typecheck`, `bun run cli:test` |
| Agent SDK | `bun run agent-sdk:typecheck`, `bun run agent-sdk:check` |
| Server build | `bun run build:server` |
| Desktop packaging | `bun run package:linux`, `bun run package:mac`, `bun run package:win` |

## Quality Gates

`bun install` configures the repository-owned pre-push hook in `.githooks`. Every push runs the canonical verifier below and rejects either a failed check or a test/build that changes source files:

```bash
bun run verify:push
```

CI executes the same quality, unit, integration, contract, and release-artifact gates in parallel, then reports one required `Checks` result. Release builds wait for that result and reuse the verified source artifacts across the platform matrix instead of rebuilding and retesting each target.

Coverage badges should be added only after coverage is collected and uploaded by CI. Until then, the CI badge is the accurate project health signal.

## Publishing Notes

The CLI package lives in `apps/cli` and is published as `openpond` with the `openpond` and `op` binaries. Stable tags publish npm provenance and GitHub CLI/Desktop artifacts only after the supported-platform smoke reports pass. Nightly tags publish GitHub artifacts without creating an npm version. See the [CLI guide](docs/public/cli.md) and [packaging policy](packaging/README.md).
