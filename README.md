# OpenPond

This repository is the canonical OpenPond monorepo. It combines the CLI/TUI, desktop app, local app server, browser renderer, terminal UI, and agent SDK into one workspace.

## Layout

```text
apps/
  cli/       # openpond/op command and TUI entrypoint
  desktop/   # Electron shell
  server/    # local app-layer harness daemon
  terminal/  # server-attached terminal UI
  web/       # shared renderer for desktop and browser mode
packages/
  agent-sdk/
  cloud/
  codex-provider/
  contracts/
  runtime/
```

## Useful Commands

```bash
bun run cli
bun run cli:typecheck
bun run cli:test
bun run cli:pack:dry-run
bun run typecheck
bun run test
bun run serve
bun run web
bun run agent-sdk:typecheck
bun run agent-sdk:check
```
