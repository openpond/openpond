<div align="center">
  <h1>OpenPond</h1>
  <p><strong>Frontier-grade agent orchestration for any model.</strong></p>
  <p>
    <a href="https://github.com/openpond/openpond/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/openpond/openpond/actions/workflows/ci.yml/badge.svg" /></a>
    <a href="apps/cli"><img alt="npm package status" src="https://img.shields.io/badge/npm-unpublished-lightgrey?logo=npm&logoColor=white" /></a>
    <img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-000000?logo=bun&logoColor=white" />
    <img alt="Language: TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178c6?logo=typescript&logoColor=white" />
  </p>
</div>

## What Is This?

OpenPond brings frontier-grade agent orchestration to any model combined with seamless toggle between local & cloud environments.

Control goals and build durable, git-backed agents from local chat, run them in a desktop app, CLI, or TUI, and move seamlessly into OpenPond Cloud when work needs cloud compute.

No login required for local work. BYOK for any model. First-class Codex support. Open source agent infrastructure you can inspect, edit, and own.

## Features

OpenPond aims to deliver these capabilities inside the familiar chat-based development environment you already use.

| Feature | Docs |
| --- | --- |
| Create durable agents in one command from any chat conversation while keeping ownership of the git-backed agent code. | [Creating durable agents](docs/public/creating-agents.md), [Agent SDK](docs/public/agent-sdk.md) |
| Move between local projects and cloud execution with OpenPond Cloud. | [OpenPond Cloud](docs/public/cloud.md) |
| Inject credentials from Google Drive, Twitter/X, and other connectors across local and cloud runs. | [Credentials and models](docs/public/credentials-and-models.md) |
| Track chat logs, runs, errors, and follow-ups with the Continuous Insights Agent. | [Continuous Insights](docs/public/continuous-insights.md) |
| Chat with any model via BYOK, with first-class support for OpenAI Codex. | [Credentials and models](docs/public/credentials-and-models.md) |
| Work locally without login; sign in only for optional cloud features like OpenPond Cloud and sync. | [Docs index](docs/public/README.md) |
| Build one-off composable goals and tasks with open source goal management. | [Goals](docs/public/goals.md) |

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
  cli/       # openpond/op/openpond-code command and TUI entrypoint
  desktop/   # Electron shell
  server/    # local app-layer daemon
  terminal/  # server-attached terminal UI
  web/       # shared renderer for desktop and browser mode
packages/
  agent-sdk/       # TypeScript-first agent SDK, templates, examples, evals
  cloud/           # cloud profile and sandbox-facing helpers
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

The CLI package lives in `apps/cli` and is configured as the public npm package `openpond` with the `openpond`, `op`, and `openpond-code` binaries. The npm badge above is marked unpublished until the package is available in the public registry.
