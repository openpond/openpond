# OpenPond App Packaging

The active release workflow produces and smokes these targets:

- Linux x64 and arm64: AppImage via `pnpm run package:linux:release`
- macOS x64 and arm64: zip via `pnpm run package:mac:release`
- CLI x64 and arm64: compiled tarballs for Linux and macOS, plus npm

Windows packaging is paused and is not advertised as supported until the NSIS lane has a real packaged smoke. The stale Homebrew and winget drafts were retired because their repository names, artifact names, versions, and checksums were not generated from the release inventory.

Signing, notarization, npm trusted publishing, and update publishing are configured in CI rather than checked into the repository. Every GitHub release includes `SHA256SUMS.txt`; the CLI installer verifies it before extraction.
