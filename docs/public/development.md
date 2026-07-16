# Development Setup

## Quick Start

OpenPond requires:

- Node.js 24.18.0
- pnpm 11.13.0

Install dependencies from the repository root and start the local app:

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the watched app server, Vite renderer, and Electron desktop app. If the app is already running, keep using the existing process instead of starting another one.

## Repository Layout

```text
apps/
  cli/            # published openpond/op CLI and bundled runtime assets
  desktop/        # Electron main process, preload, and packaging config
  server/         # local API, persistence, orchestration, and training services
  terminal/       # server-backed terminal UI
  web/            # React renderer shared by desktop and browser mode
packages/
  agent-sdk/       # agent authoring SDK, CLI, templates, examples, and evals
  cloud/           # OpenPond API, profile, Git, and hosted-workspace clients
  codex-provider/  # Codex app-server provider integration
  connected-apps/  # shared connected-app catalog and capability contracts
  contracts/       # shared schemas and cross-process TypeScript contracts
  runtime/         # provider-neutral turn, tool, and orchestration primitives
  taskset-sdk/     # Taskset validation, materialization, graders, and baselines
  training-sdk/    # training plans, bundles, destinations, and adapters
python/
  openpond-training/ # optional local training and inference worker
docs/
  public/          # user-facing product and workflow guides
  working-docs/    # implementation plans, investigations, and evidence
scripts/           # development supervision, builds, verification, and release tooling
tests/             # root unit, integration, contract, live, and smoke tests
packaging/         # platform packaging policy and release metadata
```
