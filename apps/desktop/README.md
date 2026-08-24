# OpenPond Desktop developer runbook

Run the app from the repository root:

```bash
pnpm install
pnpm dev
```

The root dev supervisor is the supported entrypoint. It builds Desktop, runs the server through Node/tsx watch mode, starts Vite, waits for both readiness contracts, and then starts Electron with the explicit reusable server URL and capability token. It owns all three process groups and drains them in `finally` on startup failure, child exit, SIGINT, or SIGTERM. `scripts/dev-web.ts` is intentionally retired.

## Ports and environment

Stable development defaults to server port `17874` and renderer port `17876`; nightly defaults the server to `17875`. Override them with `OPENPOND_SERVER_PORT`, `OPENPOND_WEB_PORT`, or the dev-runner flags. Use `OPENPOND_APP_HOME` for an isolated data directory.

Desktop reuses a server only when an explicit server URL or reuse policy is present and the matching capability token is available. Reused servers are never signalled by Desktop. Directly launching Electron without the supervisor is still supported: Desktop then owns its fallback server and renderer processes.

## Build and package

```bash
pnpm build:desktop
pnpm stage:desktop
pnpm package:linux
pnpm package:mac
```

`build:desktop` writes the bundled ESM main process and sandbox-compatible CommonJS preload directly to `apps/desktop/dist`. Staging creates a dependency-free app bundle plus a hashed target-specific runtime. The server uses Electron's built-in `node:sqlite`; only the server bundle, web build, node-pty, bindings, file-uri-to-path, and required icons enter the package.

`pnpm budgets:desktop-package` rejects oversized artifacts/resources, nonminimal `app.asar` contents, unexpected staged files, hash mismatches, foreign native binaries, maps, tests, sources, debug symbols, and static libraries.

### macOS signing and notarization

macOS packages use the hardened runtime, the Developer ID Application identity for Lost Labs LLC, and Apple notarization. `pnpm package:mac` requires a valid signing identity in the local keychain. Release CI fails closed when signing credentials are missing and verifies the Developer ID authority, stapled notarization ticket, and Gatekeeper assessment before publishing an artifact.

The `openpond/openpond` Actions secret set is:

- `MAC_CSC_LINK`: base64-encoded password-protected Developer ID `.p12` archive.
- `MAC_CSC_KEY_PASSWORD`: the dedicated `.p12` export password.
- `APPLE_API_KEY_P8`: base64-encoded App Store Connect team API key.
- `APPLE_API_KEY_ID`: the App Store Connect key ID.
- `APPLE_API_ISSUER`: the App Store Connect issuer ID.

Use a dedicated `.p12` password; never reuse a macOS login, Apple ID, or GitHub password. The release job materializes the `.p8` only in the runner's temporary directory and removes it when packaging finishes.

## Smoke and diagnostics

```bash
pnpm smoke:desktop:dev --skip-chat
pnpm smoke:desktop:packaged
```

The dev smoke proves preload/renderer/server health and a browser-level render boundary: character-by-character composer typing must not commit the sidebar. The packaged smoke proves SQLite startup, browser snapshot/screenshot/input, detached-view cleanup, and app shutdown.

Release CI runs packaged Desktop smokes on Linux and signed, notarized macOS builds for x64 and arm64. Windows is paused until an equivalent NSIS smoke is restored.
