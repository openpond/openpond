# OpenPond Desktop

OpenPond Desktop is the local-first Electron app. It keeps chat state, provider settings, approvals, source review, and process ownership on your machine while allowing selected work to run in OpenPond Cloud.

## Install and platform support

Stable GitHub releases provide packaged Desktop builds for:

- Linux x64 and arm64 as AppImage files.
- macOS x64 and arm64 as zip files.

Windows is currently paused. The repository still contains a development NSIS command, but Windows is not a supported release target until its packaged smoke lane is restored. Homebrew and winget manifests are not published.

Download a build from the GitHub release matching your architecture. Release assets are accompanied by `SHA256SUMS.txt`. macOS builds are signed with the Lost Labs LLC Developer ID, notarized by Apple, and validated with Gatekeeper before publication.

## Local-first behavior

The Desktop process owns the main window and browser views. It either reuses a healthy explicitly configured local server or starts one owned server process. Owned processes are drained and terminated with the app; reused servers are never killed by Desktop.

Durable sessions, events, approvals, usage, and projections live in the local SQLite store. Renderer state is a bounded live projection, so opening a long-running chat does not load all durable history into memory. Older selected-thread history is loaded in pages.

## Data locations

The default home is `~/.openpond` for stable and `~/.openpond-nightly` for nightly. `config.toml` holds user settings, `state/state.sqlite` holds durable records, and `secrets/` holds encrypted authentication and the private local server token. Use `OPENPOND_HOME` or `--home` for an isolated home.

Settings → Customization → Configuration exposes the shared file, effective values and recovery controls. Existing installations migrate automatically when their sources are unambiguous and stopped. See [configuration, storage and recovery](configuration.md) for the old-to-new mapping, script changes, backups and downgrade limits.

## Diagnostics and recovery

Use Settings → Diagnostics to inspect the renderer, server, owned process, and browser-control state. Diagnostic process sampling is bounded and single-flight. Renderer failures are forwarded to the local server log without including capability tokens or provider credentials.

If startup fails:

1. Confirm no stale app instance is holding the selected port.
2. Check the app log and server health diagnostics.
3. Verify that the application home is writable and its SQLite file is not on a read-only filesystem.
4. When reusing a server, verify that its token file belongs to the same app home.

## Updates

Desktop release artifacts are published through the root release workflow. The app does not treat an npm CLI version as a Desktop update. Consult GitHub releases for the current Desktop channel and platform artifacts.

For development and packaging details, see [the Desktop developer runbook](../../apps/desktop/README.md).
