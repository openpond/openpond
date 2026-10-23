# Releasing `@openpond/mcp`

MCP is released independently from Desktop and the CLI. Publish compatible
`@openpond/evals` and `openpond-sdk` versions first. The package's SDK dependency
floor must include every SDK contract imported by its tool adapters.

The initial cohort is Evals `0.12.2`, SDK `0.12.6`, MCP `0.1.0` and CLI `0.2.63`.
SDK requires Evals `^0.12.2`; MCP requires SDK `^0.12.6`. The CLI bundles these
sources and does not acquire the SDK through an npm runtime dependency.

## First publication

npm requires a package to exist before its trusted publisher can be configured.
From reviewed, clean, current `master`, with the prerequisite versions already
published and a maintainer authenticated to npm:

```sh
pnpm --dir packages/sdk run build
pnpm mcp:publish:check
npm publish ./packages/mcp --access public --ignore-scripts --provenance=false
npm trust github @openpond/mcp \
  --repo openpond/openpond \
  --file release-mcp.yml \
  --environment npm-production \
  --allow-publish
npm trust list @openpond/mcp
gh workflow run release-mcp.yml --ref master
```

Use a current npm version supporting `npm trust` (the release workflows pin
`npm@11.18.0`). Initial interactive publication needs maintainer authentication
and any required npm account confirmation. Never commit tokens. The initial
bootstrap has no GitHub OIDC provenance; record that distinction. The recovery
dispatch observes the existing immutable version and creates its package tag
and GitHub release without republishing it.

## Subsequent releases

```sh
pnpm release:mcp:patch
# or release:mcp:minor / release:mcp:major
```

Merge the generated release PR after CI passes. `release-mcp.yml` runs only from
`master`, waits for exact-source CI and the published SDK dependency, verifies
an isolated installed consumer, publishes through the `npm-production` trusted
publisher, then verifies registry integrity, signatures/provenance and actual
MCP protocol behavior before creating the package tag/release.

`pnpm --dir packages/mcp run check:consumer` packs only MCP and resolves all
runtime dependencies from npm. Its `--local-dependencies` option installs the
local Harness/Evals/SDK cohort explicitly for prepublication qualification;
that result is not published-dependency acceptance. Both modes reuse the real
MCP client protocol and authorization integration checks against the installed
tarball. Neither invokes a compiler or launches paid work.
