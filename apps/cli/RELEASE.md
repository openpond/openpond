# Release Workflow

The root stable-release workflow publishes this package to npm after every supported Desktop package and smoke report passes.

## Setup required

### npm trusted publisher
Configure npm trusted publishing for this GitHub repository/workflow.

## Release workflow

1. Run `bun run release:patch`, `release:minor`, or `release:major` from a clean `master` checkout.
2. The command creates `feat/release-vX.Y.Z`, updates every versioned workspace, runs the full checks, commits, pushes the branch, and opens a release PR. It never pushes `master` or creates a tag locally.
3. Merge the release PR after its required checks pass. The merge automatically starts `.github/workflows/release-builds.yml` for that exact `master` commit.
4. The workflow waits for the required `Checks` result on `master`, then builds and smokes Linux/macOS Desktop and CLI artifacts on x64 and arm64.
5. After the smoke reports pass, the workflow creates the tag, publishes `apps/cli` with npm provenance when configured, and publishes the GitHub release with `SHA256SUMS.txt`.

`bun run release:stable` is a manual recovery command for a checked-in version whose stable tag does not exist. Normal releases do not require it; rerun an existing failed workflow when its tag already exists.

Nightly releases publish GitHub artifacts but do not publish an npm version.
