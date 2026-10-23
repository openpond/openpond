# Internal MCP delivery

`@openpond/mcp` is a private workspace adapter for the hosted OAuth MCP route. Deliver it with the application or as an exact internal archive for a reviewed host integration. It has no independent public npm publication, trusted-publisher setup, package tag, GitHub release, or separate version-bump gate. Its package version remains packaging metadata; the reviewed source commit and archive digest identify the delivered build. The existing MIT license and attribution in [LICENSE](LICENSE) remain unchanged.

## Validate the delivered adapter

The adapter depends on `openpond-sdk@^0.12.7` for its learning, correction, queue and checkpoint contracts. Preserve compatible SDK/Evals/Harness contracts and their existing release processes. A hosted adapter archive can consume compatible registry dependencies or an explicitly packed local cohort; do not treat a workspace-linked import as proof that an archive is installable.

From the repository root, after building the required dependency cohort:

```sh
pnpm run build:mcp
node --test packages/mcp/test/protocol-boundary.test.mjs
node packages/mcp/scripts/check-installed-consumer.mjs --local-dependencies
```

The installed-consumer check packs MCP and the local Harness/Evals/SDK cohort, installs those exact archives in a clean temporary consumer, verifies installed versions, and runs the existing real MCP-client protocol/authorization integration proof against the installed adapter. Without `--local-dependencies`, it still installs the locally packed MCP archive but resolves its runtime dependencies from their supported registry releases. Neither mode publishes MCP, invokes a compiler, or launches paid work.

## Hand off an exact internal artifact

Build and qualify the reviewed source commit, then pack its adapter output:

```sh
mkdir -p artifacts/internal-mcp
npm pack ./packages/mcp --ignore-scripts --pack-destination artifacts/internal-mcp
```

Record the source commit, archive SHA-256/integrity, and compatible dependency cohort with the handoff. The consuming application must pin that exact file artifact through its existing dependency/override and lockfile workflow, verify the installed consumer boundary, and include the archive in its reproducible remote build inputs. Replacing the artifact requires a fresh source-bound handoff and the consumer's normal CI/deployment checks; an npm release of MCP adds no authority or delivery gate.

Keep the existing full CI adapter build and isolated installed-consumer proof. Hosted deployment must also verify OAuth discovery/PKCE/refresh/revocation, current-grant and membership enforcement, exact workspace/resource isolation, permitted API routes and approved spend, and real MCP client interoperability. Package metadata changes do not replace those service/security checks or prove a deployment succeeded. Customers connect to the configured hosted `/mcp/app` endpoint and complete OAuth consent; they do not install this internal archive.
