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

## Test Commands

Use the smallest confidence layer that matches the change:

```bash
pnpm run test:unit          # pure logic, package units, and server-rendered UI
pnpm run test:system        # SQLite, Git, filesystem, process, and service boundaries
pnpm run test:integration   # cross-process CLI behavior
pnpm run test:contract      # built server and Agent SDK contracts
pnpm run test:release       # built CLI distribution smoke
pnpm run test:image         # ImageMagick-dependent pixel inspection
pnpm run test:python        # both Python projects
pnpm test                   # every deterministic non-live layer
pnpm run test:live          # explicit external/live-provider checks
```

`pnpm run verify:quick` runs typechecking plus the fast unit layer. `pnpm run verify:push` is the complete local push gate. Coverage and per-file timing are collected by `pnpm run test:observe`; they run weekly in CI instead of adding instrumentation to every pull request.

Tests that launch a process, open SQLite, create a temporary filesystem, or listen on a network port belong in the system manifest at `scripts/test-suite-manifest.ts`. Keep UI tests for state, accessibility, navigation, persistence, errors, and user-visible results. Avoid assertions that only freeze a class name, wrapper, icon asset, or incidental copy.

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
```
