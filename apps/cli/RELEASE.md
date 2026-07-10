# Release Workflow

The root stable-release workflow publishes this package to npm after every supported Desktop package and smoke report passes.

## Setup required

### npm trusted publisher
Configure npm trusted publishing for this GitHub repository/workflow.

## Release workflow

1. Run `bun run release:patch`, `release:minor`, or `release:major` from a clean `master` checkout.
2. The release command updates every versioned workspace, runs the full checks, commits, tags, and pushes the release.
3. `.github/workflows/release-builds.yml` builds and smokes Linux/macOS Desktop and CLI artifacts on x64 and arm64.
4. After the smoke reports pass, a stable release publishes `apps/cli` with npm provenance and publishes the GitHub release with `SHA256SUMS.txt`.

Nightly releases publish GitHub artifacts but do not publish an npm version.
Merging that PR publishes to npm and updates `CHANGELOG.md`.
