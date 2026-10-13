---
name: openpond-cli
description: Use the OpenPond CLI for datasets, graders, experiments, model training, repos, deployments, and tools.
metadata:
  short-description: OpenPond CLI workflows
---

# OpenPond CLI

Use the official CLI for supported OpenPond operations, reusing its authentication and domain services. Check the installed command help before unfamiliar operations; use structured `--json` output and `--input-file` where supported.

For dataset, grader, experiment, training, or learning-from-logs requests, read [Experiments and training](references/experiments-and-training.md). This guidance owns the conversational flow and useful inline presentation; the app supplies resource attachment and the compact experiment bar.

## Quick setup

- Install: `npm i -g openpond` (or `npx --package openpond openpond <cmd>`)
- Auth: run `openpond login` or set `OPENPOND_API_KEY`
- Non-interactive login: `openpond login --api-key opk_...`

## Common workflows

- Create OpenPond repo and attach remote:
  - `openpond repo create --name my-repo --path .`
- Non-interactive push (tokenized remote):
  - `openpond repo create --name my-repo --path . --token`
  - `git add . && git commit -m "init"`
  - `openpond repo push --path . --branch main`
  - `openpond repo push` reads `.git/config`, temporarily tokenizes `origin`, and restores it after push.
- Watch deployments:
  - `openpond deploy watch handle/repo --branch main`
- List and run tools:
  - `openpond tool list handle/repo`
  - `openpond tool run handle/repo myTool --body '{"foo":"bar"}'`
- Account-level APIs:
  - `openpond apps list [--handle <handle>] [--refresh]`
  - `openpond apps tools`
  - `openpond apps performance --app-id app_123`
  - `openpond apps agent create --prompt "Build a daily digest agent"`

## OpenTool passthrough

Use the CLI to run OpenTool commands via `npx`:

- `openpond opentool init --dir .`
- `openpond opentool validate --input tools`
- `openpond opentool build --input tools --output dist`

## Config and URLs

- Optional env vars: `OPENPOND_BASE_URL`, `OPENPOND_API_URL`, `OPENPOND_TOOL_URL`, `OPENPOND_API_KEY`
- Cache file: `~/.openpond/cache.json` (auto-refreshes on next use)
