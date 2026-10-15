# OpenPond CLI

The `openpond` and `op` commands expose cloud APIs, local profiles, the local server, the terminal UI, and non-interactive chat from one installed package.

The package's [generated command reference](../../apps/cli/docs/command-reference.md) comes from the same registry used by parsing and `--help`.

## Install

Run the complete local web app directly from npm:

```bash
npx openpond@latest
```

This starts the local server, passes its authenticated URL directly to the system browser, and remains attached to the terminal. Press `Ctrl+C` to stop it. Conversations, settings, attachments, and other application state persist under `~/.openpond`; the directory where the command was invoked is not modified. npm's downloaded package cache is separate from OpenPond application data.

The npm path requires Node.js 24.18 or newer in the Node 24 release line. For repeated use, `npm install --global openpond` installs the same package and `openpond` has the same web-first default behavior.

GitHub releases also provide compiled tarballs for Linux and macOS on x64 and arm64. The curl installer downloads the matching tarball and `SHA256SUMS.txt`, verifies SHA-256, and installs `openpond` plus the `op` symlink under `~/.openpond/bin` by default.

The npm package and compiled archive both contain the local server, terminal companion, and built web UI. They are tested from unrelated working directories rather than relying on a source checkout.

## Local and cloud commands

Local app commands:

ACP applications can launch OpenPond's harness with `openpond acp`. See [ACP agent setup and capabilities](acp-agent.md) for dedicated-home login, manual editor configuration, permissions and session continuation.

```bash
openpond
openpond serve --port 0
openpond ui --port 0
openpond ui --no-open
openpond tui
openpond chat --message "Summarize this project" --non-interactive --yes
openpond actions check --cwd ./customer-project
openpond actions run analytics.get_summary --cwd ./customer-project --input '{"businessId":"relocation"}'
```

Cloud and account commands include `login`, `profiles`, `account`, `health`, `project`, `agent`, `sandbox`, `apps`, `tool`, and `backtest`. Run `openpond <command> --help` for the schema-generated option list.

Local Profile evaluations execute the selected Profile's tools and artifact workflow. Read the catalog, prepare an immutable run, execute that exact selection, then inspect the retained results:

```bash
openpond experiments profile-catalog --local --server-url http://127.0.0.1:17874
openpond experiments prepare-profile --local --server-url http://127.0.0.1:17874 --input-file prepare.json
openpond experiments run-profile --local --server-url http://127.0.0.1:17874 --input-file run.json
openpond experiments inspect-profile --local --server-url http://127.0.0.1:17874 --input-file inspect.json
```

Preparation selects the catalog's `definitionId`, `profileRef`, exact `profileSource`, `modelRef` and dataset/task selection. For an installation-local Dataset, supply `localDataset` with its ID, revision, workspace hash, task IDs and seed. The prepare response contains the immutable manifest; execution uses the same selection plus `expectedManifestHash` from that manifest. The local server resolves ownership and enforces its admitted limits. These commands require the running installation's app home and an HTTP loopback origin.

Inspection accepts `{ "runId": "<id>" }` for a completed run. To inspect one retained case, include `receiptId`; `eventLimit` and `eventAfterId` page its trace. After an interrupted observer, include the original prepared `manifest` and exact `receiptId` once case evidence has settled. An observer timeout does not establish that the producer stopped; inspect the original run before retrying execution.

Inspect the saved canonical Model library with `openpond training projects --json` and `openpond training inspect-project <local-model-project-id> --json` (optional `--profile`). These read-only loopback commands report exact saved Taskset availability, split counts and grader pins without exporting private task or verifier content. Portable Dataset workspaces use a different owner; a catalog miss does not invalidate an available canonical Model pin.

Pull a hosted Model and its pinned Taskset packages into an explicit local Profile with `openpond training pull-project <hosted-model-project-id> --profile <local-profile-id> --json`. The running app resolves its signed-in hosted account and checks for conflicting local changes before importing. This command uses the local app's HTTP loopback API; it does not start training or serving. Use the app's home with `--home` when running it from a separate terminal. An explicitly supplied `--snapshot-file` can recover a historical projected pin from an immutable package and its saved Taskset projection (`openpond.modelProjectPullSnapshot.v1`, with `package` and `taskset`). The app requires the authenticated Model's exact reference and full recomputed projection equality before importing; it never substitutes a snapshot automatically.

`--cwd` is an explicit local workspace override. A resumed session uses its stored workspace. Cloud project targets reject local cwd overrides instead of silently changing execution placement.

Project Actions use `openpond/actions` by default. `actions check` validates and builds their registry, `actions build` produces the deterministic local bundle, `actions run` invokes one built action in a child process, and `actions dev` watches the source tree and rebuilds after changes. These commands do not use hosted sandboxes or require an OpenPond API key.

## Authentication and configuration

`openpond login` stores account credentials in the encrypted vault under `~/.openpond/secrets/`; non-secret account definitions live in `config.toml`. Use `--account` or `OPENPOND_ACCOUNT` to select a saved account, and `--base-url` when the same handle exists at more than one endpoint. Configuration and caches are private, atomic, and locked across concurrent CLI processes.

Local `serve` and `ui` use an app-home capability token rather than a cloud API key. A normal web launch hands the authenticated URL directly to the browser without printing the token. `openpond ui --no-open` intentionally prints that URL for headless or remote workflows, so treat it as a secret.

## Machine output and exit codes

Commands supporting `--json` emit machine-readable JSON or JSONL without decorative text. Secret values are redacted from errors, event summaries, and cached partition keys.

- `0`: success.
- `1`: runtime, remote, or command failure.
- `2`: usage, parsing, or validation error.
- `124`: bounded non-interactive chat deadline expired.
- Signal exits from owned child processes are reported as failures rather than successful code-zero exits.

Unknown options are rejected by the selected command schema. Arguments after `--` are passed through unchanged.

## Updates and release sources

`openpond --check-update` checks the npm version for npm-installed clients. GitHub archive users should use GitHub releases or rerun the installer for their selected version/channel. Stable tags publish both npm provenance and GitHub checksums only after supported Desktop and CLI smokes pass; nightlies publish GitHub artifacts only.

The complete package guide lives in [apps/cli/README.md](../../apps/cli/README.md).

See [configuration, storage and recovery](configuration.md) for the shared home, settings, migration and backup commands.
