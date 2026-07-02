# OpenPond App Packaging

V1 uses electron-builder with these release paths:

- Linux: AppImage via `bun run package:linux`
- macOS: DMG and zip via `bun run package:mac`
- Windows: NSIS installer via `bun run package:win`
- Homebrew cask draft: `packaging/homebrew/Casks/openpond-app.rb`
- winget draft manifests: `packaging/winget/OpenPond.OpenPondApp*.yaml`

Signing, notarization, and update publishing are intentionally configured by CI secrets rather than checked into the repo.
