# OpenPond Terminal UI

The TUI connects to the same local server and durable runtime as Desktop. Launch it with `openpond tui`, `openpond interactive`, or `bun run terminal` from a source checkout.

## Modes

- Full-screen mode provides the transcript, composer, project/session selection, approvals, and status panels.
- Line mode supports terminal environments that do not provide the required screen capabilities.
- One-shot mode is selected by `openpond chat --non-interactive` with exactly one of `--message`, `--message-file`, or `--stdin`.

The installed CLI can start its embedded server companion automatically. `--server` connects to an explicit server; `--no-server-start` requires that server to already be available.

## Project and resume semantics

Local project selection uses the project workspace as authoritative. An explicit `--cwd` may select a contained local subdirectory. Cloud projects reject `--cwd`, and `--resume` always restores the session's stored workspace.

Cloud selection invokes the same server-owned readiness operation as Desktop. Account validation, create/resume/recreate policy, branch/source selection, polling budgets, and recorded failures therefore do not diverge between surfaces.

## Input, turns, and switching

Input stays gated until startup and the session-filtered event stream are ready. State-changing actions are serialized. A running turn is tracked by both session and turn id, and the TUI blocks session switching while that turn is active rather than attributing completion to the wrong session.

Use `/help` to list available slash commands. Common controls include project/session selection, new chat, stop, reconnect, provider/model changes, approval decisions, and exit. The exact list is rendered by the current TUI build.

## Approvals and trust

Non-interactive chat requires an explicit trust choice. `--yes` defaults to nonprompting execution; use `--approval-policy` and `--sandbox` to set narrower behavior. Valid approval policies are `on-request`, `never`, `on-failure`, and `untrusted`. Valid sandbox modes are `read-only`, `workspace-write`, and `danger-full-access`.

## Reconnects, output, and deadlines

The terminal resumes server-sent events from the last applied durable sequence and deduplicates the catch-up/live handoff. Slow subscribers are disconnected rather than retaining an unbounded server queue. Active assistant text is capped in memory and wrapped incrementally; canonical output remains durable on the server.

One-shot mode applies one end-to-end deadline across input, server startup, bootstrap, stream connection, session creation, turn submission, completion, interrupt, and cleanup. Timeout errors identify the phase and exit with code `124`. `--max-output-bytes` bounds final machine output.
