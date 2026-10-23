---
name: openpond-cli
description: Use the OpenPond CLI for datasets, graders, experiments, model training, repos, deployments, and tools.
---

# OpenPond CLI

Use the official CLI for supported OpenPond operations, reusing its authentication and domain services. Check the installed command help before unfamiliar operations; use structured `--json` output and `--input-file` where supported.

For dataset, grader, experiment, training, or learning-from-logs requests, read [Experiments and training](references/experiments-and-training.md). This guidance owns the conversational flow and useful inline presentation; the app supplies resource attachment and the Training picker and resource sidebar.

## App-scoped execution

In OpenPond chat, use the supplied scoped command executor and bundled prefix
`"$OPENPOND_CLI_NODE" "$OPENPOND_CLI_ENTRY"`. The app supplies its home,
authentication and resource association. Do not install another CLI, ask for a
login, or use the provider shell before trying this path. The answering assistant,
the evaluated model and the training base/checkpoint are separate selections.

## Standalone setup

For a terminal outside the app, first check whether the running desktop already
has an account. Use its configured home with `--home <selected-home>` before diagnosing
missing authentication. The
following setup is for a new installation:

- Install: `npm i -g openpond` (or `npx --package openpond openpond <cmd>`)
- Check local context: `openpond --home <selected-home> home`, then `openpond --home <selected-home> profiles list`. The account listing reports credential presence, not successful authentication.
- Verify cloud access only when needed: `openpond --home <selected-home> account`. Use workspace IDs returned by the account or supplied by the Console; do not pick another workspace silently.
- If credentials are missing in the correct home, run interactive `openpond --home <selected-home> login` in a private terminal, or provide `OPENPOND_API_KEY` through the execution environment. Never put a real key in a prompt, command example, or source file.
- Local Profile inspection, source authoring, and validation do not require cloud login. Do not force cloud setup for local-only work.

External coding agents use their ordinary command/file tools and the installed `openpond` binary; app-only executors, environment prefixes, and resource attachments are available only inside OpenPond. Use `openpond profile current --json` for the selected Profile source, `openpond profile catalog --json` for its contents, and the authoring skill's external interface guidance. Do not invent app tool calls in an external client.

The canonical [setup guide](https://openpond.ai/agent-setup.md) covers client installation, updates, removal, and separate verification of skills, CLI, account, and workspace. Do not start inference, evaluations, training, publishing, or deployments as a setup check.

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
- Home: stable defaults to `~/.openpond`; nightly to `~/.openpond-nightly`. `--home` or `OPENPOND_HOME` selects another home. Credentials are managed by the encrypted store; configuration lives in `config.toml` and disposable discovery caches in `cache/cache.sqlite`. Do not inspect or edit credential files directly.
