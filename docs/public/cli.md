# OpenPond CLI

The `openpond` and `op` commands expose cloud APIs, local profiles, the local server, the terminal UI, and non-interactive chat from one installed package.

The package's [generated command reference](../../apps/cli/docs/command-reference.md) comes from the same registry used by parsing and `--help`.

## Install

Run the complete local web app directly from npm:

```bash
npx openpond@latest
```

This starts the local server, passes its authenticated URL directly to the system browser, and remains attached to the terminal. Press `Ctrl+C` to stop it. Conversations, settings, attachments, and other application state persist under `~/.openpond/openpond-app`; the directory where the command was invoked is not modified. npm's downloaded package cache is separate from OpenPond application data.

The npm path requires Node.js 24.18 or newer in the Node 24 release line. For repeated use, `npm install --global openpond` installs the same package and `openpond` has the same web-first default behavior.

GitHub releases also provide compiled tarballs for Linux and macOS on x64 and arm64. The curl installer downloads the matching tarball and `SHA256SUMS.txt`, verifies SHA-256, and installs `openpond` plus the `op` symlink under `~/.openpond/bin` by default.

The npm package and compiled archive both contain the local server, terminal companion, and built web UI. They are tested from unrelated working directories rather than relying on a source checkout.

## Local and cloud commands

Local app commands:

```bash
openpond
openpond serve --port 0
openpond ui --port 0
openpond ui --no-open
openpond tui
openpond chat --message "Summarize this project" --non-interactive --yes
```

Cloud and account commands include `login`, `profiles`, `account`, `health`, `project`, `agent`, `sandbox`, `apps`, `tool`, and `backtest`. Run `openpond <command> --help` for the schema-generated option list.

`--cwd` is an explicit local workspace override. A resumed session uses its stored workspace. Cloud project targets reject local cwd overrides instead of silently changing execution placement.

## Authentication and configuration

`openpond login` stores account credentials in `~/.openpond/config.json`. Use `--account` or `OPENPOND_ACCOUNT` to select a saved account, and `--base-url` when the same handle exists at more than one endpoint. Configuration and caches are private, atomic, and locked across concurrent CLI processes.

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
