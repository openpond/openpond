# 2026-08-07 App-Server Package Architecture Audit

Status: Architecture audit complete. The Local runtime extraction and protocol
are valid Phase 2 work, but the current JSONL app-server mode still boots the
full Local product-server composition. A lean app-server composition boundary,
production tool-dispatch convergence, and one SDK package-boundary repair
remain pending before hosted adoption.

Latest checkpoint: 2026-08-07. OpenPond `master` includes runtime-convergence
PR #71. Package dependency, production reachability, source-structure, and
runtime-cycle audits pass. The product decision is to keep `apps/server` as
the Local HTTP/product host and extract a private `@openpond/app-server`
workspace package above `@openpond/agent-runtime`. Local development will use
that package behind the HTTP host; Work sandboxes will launch it directly
through the bundled `openpond app-server` command.

Related docs:

- [Agent Runtime Phases 1–2 Local Acceptance](./agent-runtime-phase-two-local-acceptance.md)
- [Agent Runtime Phase 0 Characterization](./agent-runtime-phase-zero-characterization.md)

## Summary

The repository now has a sound portable core, but two different meanings of
"app-server" remain combined in `apps/server`:

1. The Local product server supplies HTTP routes, the static renderer, SQLite,
   Settings, media, OAuth, Local Work, training, schedules, and other Desktop
   concerns.
2. The canonical agent server supplies threads, turns, provider rounds, tools,
   checkpoints, events, Harness admission, interruption, approvals, and the
   JSON-RPC/JSONL protocol.

PR #71 did not move `apps/server` into a new package. It extracted portable and
provider-neutral agent programs into `packages/agent-runtime`, then composed
those programs back into the existing `@openpond/local-server`. That matches
the literal Phase 2 plan: preserve Local behavior, add the canonical protocol,
and avoid a big-bang rewrite.

It does not yet produce the stronger target implied by "agent-only mode": a
small composition that initializes only the canonical agent service and the
adapters required for its placement. `openpond app-server` suppresses the HTTP
listener and Local schedule loop, but it still constructs the full Local
server and starts other Local lifecycle behavior. Phase 3 must finish that
composition boundary before installing the runtime inside hosted Work.

## Direct Answer: What Moved and What Did Not

### What moved into `@openpond/agent-runtime`

- Versioned JSON-RPC contracts, generated schema/client artifacts, and ordered
  JSONL transport.
- Transport-neutral thread/turn method orchestration and lifecycle telemetry.
- Provider stream consumption and provider-round sequencing.
- Provider-neutral compaction decision and full compaction program.
- Canonical event, effective-surface, checkpoint, and content-hash contracts.
- Prompt materialization and tool-catalog/dispatch primitives.

### What remained in `apps/server`

- The `openpond-app-server` executable and all process composition.
- HTTP routes, static renderer delivery, Settings, media, OAuth, and product
  APIs.
- SQLite repositories, durable sessions/turns/events, and Local Harness state.
- Provider selection, credentials, provider-specific message projection, and
  usage persistence.
- Production native tool construction, validation policy, dispatch, Work
  filesystem behavior, approvals, and connected-app execution.
- Local Work lifecycle, subagents, training, compute, background queues, and
  product schedulers.
- Translation from product `RuntimeEvent` records to canonical agent events.

Therefore the large size of `apps/server` is partly the Local HTTP product
server, but it is not only HTTP. It is still the Local host for nearly every
stateful and placement-specific agent concern.

## Current Package Map

| Layer | Packages or apps | Current responsibility |
| --- | --- | --- |
| Portable behavior | `@openpond/harness` | Immutable releases, workspaces, improvements, tools, models, hashes, and Refiner decisions. |
| Portable evaluation | `@openpond/evals` | Tasksets, graders, runs, evidence, receipts, and conformance; depends one-way on Harness. |
| Agent programs | `@openpond/agent-runtime` | Protocol, provider-round programs, compaction, events, snapshots, tool primitives, prompt materialization, and transport-neutral service methods. |
| Shared agent server, target | `@openpond/app-server` in `packages/app-server` | Private canonical agent-service composition used behind Local HTTP and directly by sandbox JSONL or hosted transports. Not implemented yet. |
| Local product host | `@openpond/local-server` in `apps/server` | Full Local composition, durable state, provider and tool adapters, HTTP/static product surface, and JSONL app-server mode. |
| Product clients | `apps/web`, `apps/desktop`, `apps/terminal` | Renderer, Electron host, and terminal client. They do not own an agent loop. |
| Distribution | `apps/cli` | Public `openpond` artifact bundling the private server, terminal, runtime, cloud, contracts, and SDK source. |
| Product contracts | `@openpond/contracts` | Private aggregation of UI, server, cloud, Harness, Evals, Work, training, and lifecycle DTOs. |
| Hosted/product client | `@openpond/cloud`, `@openpond/runtime` | Cloud API, account, profile, sandbox, hosted chat, deployment, schedule, and process helpers. `@openpond/runtime` is not the agent runtime. |
| Authored Agents | `openpond-agent-sdk` | Authoring, packaging, validating, and running deployable Agent projects, workflows, actions, Skills, schedules, and integrations. |
| Public API client | `openpond-sdk` | Hosted Work and sandbox API client. |
| Training | `@openpond/taskset-sdk`, `@openpond/training-sdk`, `@openpond/trainer-local` | Taskset materialization/evaluation, training plans/adapters, and Local compute. |
| Focused internals | `@openpond/codex-provider`, `@openpond/connected-apps`, `@openpond/logging` | Codex protocol client, connected-app catalog/contracts, and redacting file logging. |

The root README intentionally lists only the four npm-hosted packages. This
table is the internal repository map; it should remain in development and
architecture documentation rather than being copied into the public package
list.

The intended dependency center is present:

```text
@openpond/harness
  -> @openpond/agent-runtime
    -> @openpond/local-server
      -> CLI / Desktop / Web / Terminal

@openpond/harness
  -> @openpond/evals
    -> Local evaluation and training hosts
```

## Current Code Review

- `packages/agent-runtime/package.json`: the private runtime depends only on
  Harness and Zod, preserving the portable boundary.
- `packages/agent-runtime/src/service.ts`: HTTP, JSON-RPC, and future hosted
  transports share one method orchestrator, but durable lifecycle operations
  are supplied through host ports.
- `packages/agent-runtime/src/provider-loop.ts`: the package owns normalized
  provider stream consumption and round sequencing.
- `packages/agent-runtime/src/compaction.ts`: the package owns the full
  provider-neutral compaction order while hosts supply event projection,
  persistence shapes, and provider access.
- `packages/agent-runtime/src/tools.ts`: the package defines an executable
  catalog and validated dispatch primitive, but production Local execution
  currently uses only its catalog projection.
- `apps/server/src/runtime/local-agent-runtime-host.ts`: Local sessions, turns,
  approvals, Harness operations, and stored runtime events adapt into the
  transport-neutral service.
- `apps/server/src/runtime/hosted-turn/tool-loop-runtime.ts`: the Local host
  builds the effective native definitions, records their projected hash, and
  still calls the server-owned native dispatcher.
- `apps/server/src/cli.ts`: `app-server` mode calls the same
  `createOpenPondServer` composition as Local product modes with HTTP disabled,
  then attaches JSONL over stdio.
- `apps/server/src/index.ts`: the 1,968-line composition root wires the full
  Local product, agent, Work, Harness, training, compute, and HTTP surfaces.
  With HTTP disabled it still recovers pending subagents and starts the Work
  sandbox lifecycle.
- `packages/sdk/src/index.ts` and `packages/sdk/src/work.ts`: the public SDK
  imports private Cloud source through relative cross-package paths. The build
  bundles this successfully, but the coupling is absent from the SDK manifest
  and invisible to the dependency-boundary check.
- `packages/contracts/src/index.ts`: the private aggregation package exports
  more than sixty product and portable domains. This is acceptable for the
  Local product but must not become the hosted agent protocol dependency.

## Findings

### 1. Agent-only transport exists without agent-only composition

`httpEnabled: false` prevents the listener from binding and keeps the Local
schedule loop stopped. It does not select a smaller dependency graph or skip
the rest of `createOpenPondServer` composition. This creates unnecessary
startup, dependency, credential, lifecycle, and audit surface for a future
Work-sandbox runtime.

This is the primary architecture issue for hosted convergence. The protocol is
independent; the executable composition is not yet independent.

### 2. Production tool dispatch remains Local-host-owned

The production tool list and catalog hash are derived from the same Local
native definitions, so current capability evidence is causal. However,
`createAgentToolCatalog` and `executeAgentTool` are exercised only by runtime
package tests. The Local provider loop projects definitions through
`createAgentToolCatalogProjection`, then dispatches through
`executeNativeToolCalls` in `apps/server`.

The hosted move must not build another tool registry beside this one. The
runtime executable needs one authoritative registry that generates provider
schemas, capability projection, validation, dispatch, and the recorded hash,
while placement adapters supply actual Local or managed executors.

### 3. The public SDK has an undeclared source-level Cloud dependency

`openpond-sdk` imports `../../cloud/src/...` directly and bundles those files.
This is a hidden package boundary: the manifest advertises no dependency while
the implementation follows private Cloud source layout. The current dependency
checker ignores relative imports, including relative imports that cross a
workspace-package root.

### 4. Package names obscure distinct runtime concepts

`@openpond/runtime`, `@openpond/agent-runtime`, and `openpond-agent-sdk` are
three valid but separate concepts:

- Product/cloud client orchestration.
- Canonical conversational agent execution programs.
- Authored Agent project SDK and runtime.

The code boundaries are mostly sound, but future architecture docs and hosted
code must use the full package names rather than the unqualified word
"runtime." `@openpond/contracts` must remain a private product aggregation
rather than becoming the shared hosted runtime surface.

### 5. The Local product composition root remains at its size limit

`apps/server/src/index.ts` has 1,968 lines against the repository's 1,999-line
handwritten-file maximum and is allowlisted from the newer 999-line production
module limit. The repository currently has zero cycles in the server
runtime/openpond graph, so this is not evidence of broken behavior. It is a
change-isolation and ownership risk: the next hosted slice should reduce this
composition root rather than add hosted adapters directly to it.

### 6. Training and compute are Local product concerns, not app-server concerns

The repository currently carries three private training packages plus a Python
worker:

| Surface | Current role | Disposition |
| --- | --- | --- |
| `@openpond/taskset-sdk` | Taskset validation, hashing, materialization, local grader execution, and portable local runtime helpers. It also re-exports Harness and Evals contracts. | Keep while training cleanup is in progress, then evaluate merging its public Taskset/evaluation primitives into `@openpond/evals` and keeping host-only materialization code private. It is not removable as dead code today. |
| `@openpond/training-sdk` | Portable training plans, bundles, compatibility checks, destinations, and compute/engine/runtime adapter contracts. | Keep only to the extent that managed training still uses the portable plan and adapter boundary. Re-audit after Fireworks and local-provider removal; a managed-only product may need a materially smaller package. |
| `@openpond/trainer-local` | An 85-line Local compute-target adapter. | Fold into the Local training host if Local training remains; delete with the Local training path if it does not. A standalone package is not justified by the current implementation. |
| `python/openpond-training` | Optional local/native dataset, SFT/PPO, inference, model-manager, and vLLM evaluation worker. | Keep only if Local training or local model inference remains a supported product. It is active, not orphaned: the Local CPU destination invokes it, contracts generate schemas into it, push verification runs it, and CI tests it. Never include it in `@openpond/app-server` or the sandbox runtime. |

The generic compute layer is also active and is not a Prime provider wrapper.
It inventories Local CPU/device/runtime/storage state, manages model downloads,
and supplies the Local training adapter. Removing Prime therefore does not by
itself justify deleting `packages/contracts/src/compute.ts`, the Local compute
service, or Settings compute UI. Those surfaces should be removed only if the
product also drops Local training, local inference, and local model management.

### 7. Prime is retired implementation-wise but leaves stale residue

No live Prime compute-provider implementation or Prime package remains in the
workspace. The remaining provider-specific residue is documentation, unused
`.prime-compute-*` styles, an old `prime_hosted` stored-value decoder, a Taskset
authoring reference, and a stale Python worker SBOM that still names Prime RL
and Verifiers. Generic wording such as "Prime-style environment" in Evals is a
semantic description rather than provider integration.

The retired Prime documentation, styles, generated Skill artifact, and SBOM
entries should be removed or regenerated. The stored-value decoder needs a
separate data-compatibility decision: removing a provider does not necessarily
mean old local records should become unreadable.

### 8. Fireworks remains a large live product path

Fireworks is not merely a compute provider package. It is a provider-native
SFT/RFT destination with credentials, dataset projection, launch/status/
cancel/collection, evaluation serving, RFT environments, API routes, product
UI, contracts, persistence, tests, and public documentation. The audit found
Fireworks references across more than seventy application, package,
documentation, and root README files.

The product direction is OpenPond Managed RL rather than Fireworks BYOK.
Retiring Fireworks is therefore correct, but it must be handled as a focused
cross-layer deletion. The managed adapter already submits to the authenticated
OpenPond hosted API and does not require desktop Fireworks credentials. Remove
Fireworks destination contracts, server composition, secrets and routes, UI,
tests, and public claims together so the remaining managed path is coherent.
Do not move any Fireworks code into `@openpond/app-server` as an intermediate
step.

### 9. The top-level `packaging` directory is documentation-only

`packaging/` contains only `README.md`; active Electron packaging configuration
lives under `apps/desktop`, while release automation lives in root scripts and
GitHub Actions. The folder can be removed after preserving any unique release
policy in the Desktop or public release documentation and removing its one
repository-layout reference from `docs/public/development.md`. Removing the
folder does not remove or change actual AppImage, macOS, CLI, signing, or
release packaging.

## Hosted Readiness Gate

Not every cleanup item blocks hosted adoption. The required gate is a lean,
shared app-server whose dependency graph excludes all Local product-only
services. Hosted Work must not carry Python training, Local compute discovery,
Fireworks, product HTTP/static routes, Desktop schedulers, or nested sandbox
management.

| Work | Required before hosted sandbox launch? | Reason |
| --- | --- | --- |
| Extract `@openpond/app-server` and converge tool dispatch | Yes | This is the runtime that the sandbox will actually start and the authority boundary hosted depends on. |
| Prove the sandbox composition excludes training/compute/product services | Yes | A hidden full-Local boot would carry unnecessary credentials, lifecycle behavior, and attack surface into hosted Work. |
| Remove Prime residue | No runtime dependency, but complete before the hosted product is presented as managed-only | The implementation is already absent; cleanup makes docs, generated artifacts, and supply-chain metadata truthful. |
| Remove Fireworks BYOK | Not structurally required if the lean app-server excludes it, but complete before the managed-only training product is declared converged | It is still an exposed Local product path and public promise, not a sandbox runtime dependency. |
| Decide whether Local Python training/inference remains | No, provided it is excluded from app-server | This is a Local product-scope decision. If unsupported, delete it and its TypeScript composition/tests in a focused change. |
| Remove `packaging/` documentation folder | No | It has no runtime or release-build ownership. |
| Consolidate training packages | No, provided none enter app-server | This reduces repository complexity but does not determine hosted agent correctness. |

## Product Decision

Keep `@openpond/agent-runtime` as the portable/private agent-program package.
Do not move Local product concerns into it and do not rename it during hosted
adoption.

Keep `apps/server` as the Local product host for HTTP, static web delivery,
SQLite, Settings, media, OAuth, Local schedules, training, and other Desktop
composition. Its `serve` and `web` modes remain the Local HTTP entrypoints.

Create a private `@openpond/app-server` workspace package at
`packages/app-server` above `@openpond/agent-runtime`. It owns the canonical
agent-service composition and accepts typed placement adapters. It is not a
separately published npm package; the public `openpond` CLI bundles it.

Treat OpenPond Managed RL as the supported remote-training direction. Retire
the Fireworks BYOK product path and remaining Prime artifacts in focused
cleanup work; do not use either as a hosted app-server dependency. Keep Local
training, inference, and compute only if they remain intentional Desktop/Local
features after that product-scope review.

Use that package in both placements:

- `pnpm dev` starts `apps/server`, Vite, and Desktop. `apps/server` constructs
  `@openpond/app-server` behind the Local HTTP compatibility and product APIs.
- `openpond serve` and `openpond ui` start the same Local HTTP/product host.
- `openpond app-server` starts `@openpond/app-server` directly without the
  Local HTTP/static/product layer. This is the command installed in hosted Work
  sandboxes.

The target end state is:

```text
@openpond/harness
  -> @openpond/agent-runtime
    -> @openpond/app-server
      -> JSONL stdio transport
      -> future authenticated hosted transport
      -> Local HTTP compatibility adapter in apps/server

apps/server
  -> Local product adapters
  -> Local HTTP/static product surface
  -> lean app-server composition
```

The package boundary is an implementation constraint, not a new public
distribution surface. `openpond app-server` must initialize it without
constructing HTTP/static routes, training, Local product schedulers, unrelated
cloud lifecycle services, or nested Work-sandbox management.

## Boundaries

- Do not move SQLite, provider credentials, React, Electron, HTTP product
  routes, training, or cloud product state into `@openpond/agent-runtime`.
- Do not publish the internal runtime or app-server composition solely to make
  hosted adoption possible; the CLI can continue distributing the executable.
- Do not create separate Local and hosted implementations of provider-round,
  compaction, checkpoint, event, prompt, or tool-catalog programs.
- Do not use `@openpond/contracts` as the hosted JSON-RPC contract. Use the
  generated agent protocol and focused portable packages.
- Do not add hosted placement adapters to the existing 1,968-line composition
  root without first establishing the lean boundary.
- Do not preserve direct cross-package source imports in public packages when a
  supported export or owned implementation boundary can express the same API.

## Phases

### Phase 0 - Audit the current package and execution boundaries

- [x] Inventory all five apps and fourteen packages. Done: recorded package
  roles, visibility, dependency direction, executable entrypoints, and
  distribution behavior.
- [x] Verify the Local runtime convergence boundary. Done: confirmed shared
  HTTP/JSON-RPC service composition, portable provider/compaction programs,
  Local host ports, and canonical artifact ownership.
- [x] Run structural validation. Done: dependency declarations, production
  reachability, source structure, and server runtime-cycle checks pass.
- [x] Identify gaps against the hosted target. Done: isolated full-server boot,
  Local-owned production dispatch, hidden SDK coupling, naming ambiguity, and
  composition-root size.
- [x] Audit training, compute, and packaging scope. Done: distinguished active
  Local compute from retired Prime residue, confirmed Fireworks is a live
  cross-layer destination, traced the Python worker into Local and CI entrypoints,
  and identified the documentation-only packaging folder.

### Phase 1 - Establish lean app-server composition

- [ ] Define the exact services and adapters required by agent-only mode.
- [ ] Create private `packages/app-server` above `@openpond/agent-runtime`
  without changing Local thread/turn behavior.
- [ ] Make `openpond app-server` construct `@openpond/app-server` directly.
- [ ] Keep `serve` and `web` modes in `apps/server` and adapt their agent routes
  to the same package.
- [ ] Prove agent-only boot does not construct or start excluded Local product
  services.

### Phase 2 - Finish authoritative runtime tool ownership

- [ ] Adapt production native tool definitions into the executable Agent
  Runtime catalog rather than projection-only use.
- [ ] Derive provider schemas, capability projection, validated dispatch, and
  tool-catalog hash from the same admitted registry.
- [ ] Keep executor implementations in placement adapters.
- [ ] Repeat Local Chat, projectless Work, Project-backed Work, approval,
  interruption, compaction, and Harness snapshot acceptance.

### Phase 3 - Repair package-boundary and architecture guardrails

- [ ] Replace the public SDK's relative Cloud source imports with a supported
  package boundary or SDK-owned client primitives.
- [ ] Extend dependency validation to reject relative imports that escape one
  workspace package and enter another package's source tree.
- [ ] Add an architecture check or focused test proving agent-only composition
  excludes the Local product surface.
- [ ] Document the distinct responsibilities of `@openpond/runtime`,
  `@openpond/agent-runtime`, and `openpond-agent-sdk` in the package inventory.

### Phase 4 - Begin hosted adoption

- [ ] Publish a CLI version containing the lean app-server entrypoint.
- [ ] Install the pinned CLI in the Work sandbox image.
- [ ] Add one authenticated hosted transport and health/readiness contract.
- [ ] Preserve the Local acceptance matrix and pass hosted no-Project Work
  before adding Project-backed Development.

## Validation

- Passed: `pnpm run dependencies:check` reported all 20 workspace projects and
  direct package imports valid.
- Passed: `pnpm exec tsx scripts/check-source-structure.ts` reported 1,262
  production modules, 1,927 handwritten files, and zero runtime/openpond
  cycles.
- Passed: `pnpm exec tsx scripts/report-server-runtime-cycles.ts` reported 128
  modules, 262 local edges, and zero cycles.
- Passed: `pnpm exec tsx scripts/check-production-entrypoints.ts` reported
  1,198 production modules reachable from 120 supported roots.
- Passed previously: PR #71 unit, integration, runtime-contract,
  quality/build, release-artifact, and aggregate GitHub checks.
- Not run for this documentation-only audit: full unit, integration, package,
  or Desktop acceptance matrices. No production code changed.

## Open Questions

- Should `apps/server` embed `@openpond/app-server` in-process during Local
  development, or supervise it as a child process? The initial extraction
  should prefer in-process composition unless process isolation is required by
  a concrete failure or deployment boundary.
- Which exact Local host services are required for agent-only Chat and Work,
  and which current `createOpenPondServer` services must be forbidden?
- Should the first production catalog adoption wrap the current
  `ModelToolDefinition` executors, or should that type be replaced directly by
  `AgentToolDefinition`?
- Should the public SDK own its HTTP/sandbox client implementation, or should a
  focused publishable client-core package replace the private Cloud imports?

## Progress Log

- 2026-08-07: Audited the post-PR #71 package graph, runtime composition,
  production entrypoints, package boundaries, tool registry, agent-only boot,
  and source structure. Recorded the distinction between the completed Local
  extraction and the still-pending lean executable boundary.
