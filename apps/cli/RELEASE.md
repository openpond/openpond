# Release Workflow

This package uses [Changesets](https://github.com/changesets/changesets) for version management and publishing to npm.

## Setup required

### 1) npm trusted publisher
Configure npm trusted publishing for this GitHub repository/workflow.

### 2) GitHub token
`GITHUB_TOKEN` is provided by GitHub Actions.

## Development workflow

1) Make your changes
2) Create a changeset:
   ```bash
   npm run changeset
   ```
3) Commit code + changeset
4) Open a PR to `master`

When changesets are merged into `master`, the release workflow will open a Version Packages PR.
Merging that PR publishes to npm and updates `CHANGELOG.md`.
