# 2026-08-07 App-Server Package Architecture Audit

Status: Lean runtime convergence is implemented and validated. Retired provider
cleanup, executable tool-catalog convergence, the private app-server package,
SDK guardrails, and the dedicated hosted placement adapter are complete.
`openpond app-server` starts the canonical agent runtime without constructing
the Local HTTP/product server. In hosted Web, that process runs outside the
compute sandbox and forwards only the attached sandbox's bounded Work actions
through the scoped Sandbox API.

Next proof: publish and pin the CLI in the hosted worker image, complete the
JSONL readiness handshake there, and pass no-Project Work against a separately
provisioned, exactly scoped compute sandbox before enabling Project-backed
Development.

Latest checkpoint: 2026-08-07. Local Python training, local inference, Compute
settings, and `@openpond/trainer-local` remain supported and are explicitly
deferred from this cleanup. Prime and Fireworks integration residue plus the
documentation-only packaging folder are removed. `@openpond/app-server` now
owns canonical service/JSONL composition, Local HTTP uses it in-process, and
native provider tools execute through the same admitted catalog that produces
schemas, capability evidence, and hashes. The dedicated runtime reports the
`hosted_work` placement and serves JSONL stdio from the host placement while
the Sandbox API owns compute/file execution. A real `pnpm dev` upgrade
walkthrough also exposed and repaired
clean-checkout SDK build ordering plus persisted Prime, Fireworks, and
hosted-BYOK training values that previously blocked bootstrap against an
existing Local database.

Related docs:

- [Agent Runtime Phases 1–2 Local Acceptance](./agent-runtime-phase-two-local-acceptance.md)
- [Agent Runtime Phase 0 Characterization](./agent-runtime-phase-zero-characterization.md)

## Summary

The repository now separates the two meanings that were previously combined in
`apps/server`:

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

The stronger "agent-only mode" target is now implemented. `openpond app-server`
loads `apps/server/src/app-server-entry.ts`, constructs only the hosted placement
adapters required by `@openpond/app-server`, and serves the canonical protocol
over JSONL stdio. The command does not call `createOpenPondServer`, bind an HTTP
listener, scan Local compute, start training or product schedules, initialize
Desktop services, or provision a nested Work sandbox.

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

- The Local `serve` and `web` executables plus placement-specific composition.
- HTTP routes, static renderer delivery, Settings, media, OAuth, and product
  APIs.
- SQLite repositories, durable sessions/turns/events, and Local Harness state.
- Provider selection, credentials, provider-specific message projection, and
  usage persistence.
- Production native tool construction, validation policy, dispatch, Work
  filesystem behavior, approvals, and connected-app execution.
- Local Work sandbox lifecycle, training, compute, product background queues,
  and product schedulers.
- Translation from product `RuntimeEvent` records to canonical agent events.

The large size of `apps/server` is therefore the Local product host, not the
hosted runtime. The dedicated app-server entrypoint still lives in this app so
it can reuse focused SQLite, provider, workspace, approval, connected-app, and
Harness adapters, but its reachable composition is now explicitly small and
guarded by tests. Moving those adapters into another package is no longer a
hosted-launch prerequisite.

## Current Package Map

| Layer | Packages or apps | Current responsibility |
| --- | --- | --- |
| Portable behavior | `@openpond/harness` | Immutable releases, workspaces, improvements, tools, models, hashes, and Refiner decisions. |
| Portable evaluation | `@openpond/evals` | Tasksets, graders, runs, evidence, receipts, and conformance; depends one-way on Harness. |
| Agent programs | `@openpond/agent-runtime` | Protocol, provider-round programs, compaction, events, snapshots, tool primitives, prompt materialization, and transport-neutral service methods. |
| Shared agent server | `@openpond/app-server` in `packages/app-server` | Private canonical agent-service and JSONL lifecycle composition used by both Local HTTP and the dedicated hosted entrypoint. |
| Local product host | `@openpond/local-server` in `apps/server` | Full Local HTTP/static product composition plus focused placement adapters for the lean hosted app-server executable. |
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
- `packages/agent-runtime/src/tools.ts`: the package defines both Zod-native and
  JSON-schema-backed executable catalogs. Production Local execution now uses
  the projected catalog for provider schemas, capability/hash evidence, and
  dispatch while Local closures retain placement-specific executors.
- `apps/server/src/runtime/agent-runtime-host.ts`: typed placement ports adapt
  sessions, turns, approvals, Harness operations, and stored runtime events
  into the transport-neutral service for both Local and hosted compositions.
- `apps/server/src/app-server-runtime.ts`: the dedicated `hosted_work`
  composition initializes SQLite, the hosted provider, workspace tools,
  connected apps, approvals, Harness/Refiner, Agent Runtime, and JSONL only.
- `apps/server/src/runtime/app-server-workspace.ts` and
  `apps/server/src/runtime/app-server-sandbox-tools.ts`: local placement tools
  remain host-local, while hosted Work file/command actions are restricted to
  the already-attached sandbox id and forwarded through the scoped Sandbox API.
- `apps/server/src/runtime/hosted-turn/tool-loop-runtime.ts`: the Local host
  builds the effective native definitions, records their projected hash, and
  still calls the server-owned native dispatcher.
- `apps/server/src/app-server-entry.ts` and `apps/server/src/cli.ts`:
  `app-server` mode imports the lean factory directly and attaches JSONL over
  stdio; it does not import or call the Local product composition root.
- `apps/server/src/index.ts`: the 1,953-line composition root remains the Local
  product host for agent, Work, Harness, training, compute, and HTTP surfaces.
  Its Local routes reuse the same typed Agent Runtime ports and
  `@openpond/app-server` service composition in-process.
- `apps/cli/src/cli/main.ts`: the bundled `__app-server` companion dynamically
  imports only the dedicated runtime subpath, while `__server` retains the
  Local `serve`/`web` product host.
- `packages/sdk/src/index.ts` and `packages/sdk/src/work.ts`: the public SDK now
  imports supported `@openpond/cloud` subpath exports and declares Cloud as a
  bundled source dependency. Dependency validation also rejects future
  production relative imports that escape into another workspace package.
- `packages/contracts/src/index.ts`: the private aggregation package exports
  more than sixty product and portable domains. This is acceptable for the
  Local product but must not become the hosted agent protocol dependency.

## Findings

### 1. Agent-only transport and composition are now aligned

The original audit found that `httpEnabled: false` suppressed the listener but
still constructed the full Local product server. The command now selects a
dedicated executable and `createOpenPondAppServer` factory. Its declared
composition contains twelve focused services and explicitly excludes HTTP,
static delivery, training, compute, schedules, Desktop, remote access, and
sandbox provisioning. Its remote sandbox adapter is a bounded client for the
pre-attached workspace, not a compute lifecycle owner.

This closes the primary architecture issue for hosted convergence. Both the
protocol and the executable composition are independent of the Local product
host.

### 2. Production tool dispatch now has one admitted catalog

The Local provider loop adapts placement-specific `ModelToolDefinition`
executors into one executable Agent Runtime catalog. Provider schemas,
capability projection, the recorded catalog hash, and dispatch now consume
that same admitted object. Local event recording and execution policy remain
in the placement adapter; hosted code must reuse the catalog rather than add a
second registry.

### 3. The public SDK package boundary is repaired

`openpond-sdk` uses supported Cloud subpath exports and explicitly records its
bundled source dependency. The workspace dependency checker resolves relative
production imports to their owning package and fails when code crosses a
package root without a declared boundary.

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

`apps/server/src/index.ts` has 1,953 lines against the repository's 1,999-line
handwritten-file maximum and is allowlisted from the newer 999-line production
module limit. The repository currently has zero cycles in the server
runtime/openpond graph, so this is not evidence of broken behavior. It is a
change-isolation and ownership risk for Local product work, but it is no longer
the hosted app-server composition root. Future Local cleanup should continue to
split it without blocking hosted rollout.

### 6. Training and compute are Local product concerns, not app-server concerns

The repository currently carries three private training packages plus a Python
worker:

| Surface | Current role | Disposition |
| --- | --- | --- |
| `@openpond/taskset-sdk` | Taskset validation, hashing, materialization, local grader execution, and portable local runtime helpers. It also re-exports Harness and Evals contracts. | Keep while training cleanup is in progress, then evaluate merging its public Taskset/evaluation primitives into `@openpond/evals` and keeping host-only materialization code private. It is not removable as dead code today. |
| `@openpond/training-sdk` | Portable training plans, bundles, compatibility checks, destinations, and compute/engine/runtime adapter contracts. | Keep only to the extent that managed training still uses the portable plan and adapter boundary. Re-audit after Fireworks and local-provider removal; a managed-only product may need a materially smaller package. |
| `@openpond/trainer-local` | An 85-line Local compute-target adapter. | Keep for the current Local training product. Package consolidation is deferred with the broader Local training cleanup. Never include it in `@openpond/app-server`. |
| `python/openpond-training` | Optional local/native dataset, SFT/PPO, inference, model-manager, and vLLM evaluation worker. | Keep. It remains the supported Local training/inference worker: the Local CPU destination invokes it, contracts generate schemas into it, push verification runs it, and CI tests it. Never include it in `@openpond/app-server` or the sandbox runtime. |

The generic compute layer is also active and is not a Prime provider wrapper.
It inventories Local CPU/device/runtime/storage state, manages model downloads,
and supplies the Local training adapter. Removing Prime therefore does not by
itself justify deleting `packages/contracts/src/compute.ts`, the Local compute
service, or Settings compute UI. Those surfaces should be removed only if the
product also drops Local training, local inference, and local model management.

### 7. Prime retirement is complete in the active product surface

No live Prime compute-provider implementation, package, documentation, style,
stored destination, generated Skill wording, or worker SBOM entry remains.
Ordinary uses of “prime” in mathematics and UI cursor initialization are not
provider integration. Generic Local compute remains intentionally supported.

### 8. Fireworks BYOK is removed

The provider-native destination, credentials, dataset/evaluation/serving
runtimes, callbacks, provider settings, contracts, storage, UI actions, tests,
fixtures, scripts, and public claims are removed together. OpenPond Managed RL
and retained Local training are the remaining destinations. The managed
adapter continues to use the authenticated hosted API and owns no desktop
provider credential.

### 9. The top-level `packaging` directory is removed

The documentation-only folder and its repository-layout reference are gone.
Active Electron packaging remains under `apps/desktop`; root scripts and
GitHub Actions still own release automation.

### 10. Clean installation and existing-state upgrades are covered

The initial CI run failed before tests because a clean checkout built
`openpond-sdk` before its private bundled Cloud dependency had emitted
`dist/*`. The SDK package now builds Cloud in its `prebuild` lifecycle, so the
same package command works with no cached workspace artifacts.

The first real `pnpm dev` walkthrough also found that an existing Local
database could not bootstrap after provider retirement. Stored
`openpond_fireworks` serving lineage, `prime_hosted` model defaults, and the
retired `openpond_managed`/`hosted_byok` readiness classes are now handled by
the existing read-normalization boundary. They are ignored or cleared rather
than re-enabling retired providers, mutating the database in place, or asking
users to delete Local state. Regression tests cover direct reads and lists for
all three shapes.

## Hosted Readiness Gate

The code-level hosted gate is now satisfied: the shared app-server dependency
graph excludes Local product-only services. Hosted Work does not initialize
Python training, Local compute discovery, Fireworks, product HTTP/static
routes, Desktop schedulers, or sandbox provisioning. It may call the scoped
Sandbox API for the exact compute workspace attached by the control plane. The
remaining gate is operational distribution and staging proof.

| Work | Required before hosted sandbox launch? | Reason |
| --- | --- | --- |
| Extract `@openpond/app-server` and converge tool dispatch | Complete | The Local and hosted placements use the same canonical service, admitted tool catalog, and JSONL lifecycle. |
| Prove the sandbox composition excludes training/compute/product services | Complete | Source guards, composition assertions, process tests, and production reachability cover the dedicated executable. |
| Remove Prime residue | Complete | The implementation and stale documentation, generated artifacts, styles, and supply-chain metadata are gone. |
| Remove Fireworks BYOK | Complete | The retired Local product path and public promise are gone; managed and Local training remain. |
| Keep Local Python training/inference out of app-server | Complete | The retained Local feature is not constructed or imported by the hosted executable. |
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
training, inference, compute, and their Python worker as intentional
Desktop/Local features. Their future simplification is a separate product
decision and must not be folded into this hosted-runtime change.

Use that package in both placements:

- `pnpm dev` starts `apps/server`, Vite, and Desktop. `apps/server` constructs
  `@openpond/app-server` behind the Local HTTP compatibility and product APIs.
- `openpond serve` and `openpond ui` start the same Local HTTP/product host.
- `openpond app-server` starts `@openpond/app-server` directly without the
  Local HTTP/static/product layer. This is the command installed in hosted Work
  sandboxes.

The sandbox supervisor should launch the pinned CLI with the sandbox workspace
as its current directory and a durable state directory, for example
`openpond app-server --home <durable-state-dir>`. The supervisor owns the
process and exchanges newline-delimited JSON-RPC on stdin/stdout. Readiness is
the successful `initialize`/`initialized` handshake followed by
`runtime/capabilities` and `harness/validate`; there is no app-server HTTP port
or banner to scrape. Work resource, file, command, and git tools operate in the
supervisor-provided current directory.

The target end state is:

```text
@openpond/harness
  -> @openpond/agent-runtime
    -> @openpond/app-server
      -> JSONL stdio transport
      -> Local HTTP compatibility adapter in apps/server

apps/server
  -> Local product adapters
  -> Local HTTP/static product surface
  -> lean app-server composition
```

The package boundary is an implementation constraint, not a new public
distribution surface. `openpond app-server` must initialize it without
constructing HTTP/static routes, training, Local product schedulers, unrelated
cloud lifecycle services, or Work-sandbox provisioning. Hosted placement may
use the scoped remote-workspace client for an already-attached sandbox.

## Boundaries

- Do not move SQLite, provider credentials, React, Electron, HTTP product
  routes, training, or cloud product state into `@openpond/agent-runtime`.
- Do not publish the internal runtime or app-server composition solely to make
  hosted adoption possible; the CLI can continue distributing the executable.
- Do not create separate Local and hosted implementations of provider-round,
  compaction, checkpoint, event, prompt, or tool-catalog programs.
- Do not use `@openpond/contracts` as the hosted JSON-RPC contract. Use the
  generated agent protocol and focused portable packages.
- Do not add hosted placement adapters to the existing 1,953-line composition
  root without first establishing the lean boundary.
- Do not preserve direct cross-package source imports in public packages when a
  supported export or owned implementation boundary can express the same API.
- Do not remove or disconnect `python/openpond-training`, Local CPU training,
  local trained-model inference, Compute settings, or `@openpond/trainer-local`
  in this implementation.

## Phases

### Phase 0 - Audit the current package and execution boundaries

- [x] Inventory all five apps and fifteen packages. Done: recorded package
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

### Phase 1 - Remove retired and misleading surfaces

- [x] Remove Prime documentation, unused UI styles, generated Skill residue,
  and stale supply-chain metadata. Done: provider residue is gone; generic
  Local compute, model management, and Compute settings are unchanged.
- [x] Remove Fireworks BYOK server, contracts, provider settings, UI, storage,
  tests, and public claims. Done: managed registry/chat and Local training are
  retained; direct provider credentials, serving sessions, and callbacks are gone.
- [x] Remove the documentation-only `packaging/` folder. Done: active Desktop
  and release configuration remains in its real owners; the stale layout link is gone.
- [x] Prove Local Python training, local inference, Compute settings, and their
  tests remain intact. Done: all 38 Python contract, dataset, adapter,
  inference, vLLM, policy-manager, local SFT/DPO/PPO, and worker tests pass;
  Compute UI and `@openpond/trainer-local` remain present.
- [x] Preserve existing Local state across retired-provider cleanup. Done:
  Fireworks serving lineage is ignored, Prime model defaults are cleared, and
  retired hosted readiness classes are filtered during stored-payload reads;
  bootstrap succeeds without deleting or rewriting the user's database.

### Phase 2 - Establish lean app-server composition

- [x] Define the canonical services and adapter interface required by
  agent-only mode. Done: service ports, runtime host, JSONL I/O, and idempotent
  close ownership live above Agent Runtime; placement state stays outside.
- [x] Create private `packages/app-server` above `@openpond/agent-runtime`.
  Done: the 21st workspace package depends only on Agent Runtime and Node I/O;
  focused composition and shutdown tests pass.
- [x] Make `openpond app-server` construct `@openpond/app-server` directly.
  Done: the dedicated entrypoint imports `createOpenPondAppServer`, supplies
  typed hosted ports, and never constructs `createOpenPondServer`.
- [x] Keep `serve` and `web` modes in `apps/server` and adapt their agent routes
  to the same package. Done: Local HTTP uses the in-process app-server runtime;
  product HTTP/static ownership remains in `apps/server`.
- [x] Prove agent-only boot does not construct or start excluded Local product
  services. Done: composition and source guards exclude HTTP, static product,
  training, compute, schedules, Desktop, remote control, and sandbox
  provisioning services; an installed-CLI smoke boots from an unrelated
  directory with clean JSONL, and focused tests prove exact-id remote Work
  forwarding.

### Phase 3 - Finish authoritative runtime tool ownership

- [x] Adapt production native tool definitions into the executable Agent
  Runtime catalog. Done: JSON-schema projections now carry admitted executors
  and optional argument validation instead of remaining evidence-only objects.
- [x] Derive provider schemas, capability projection, dispatch, and
  tool-catalog hash from the same admitted registry. Done: the Local tool loop
  records and executes the exact catalog sent to the provider.
- [x] Keep executor implementations in placement adapters. Done: Local tool
  definitions close over Local sessions, permissions, Work state, and events;
  Agent Runtime owns only admission and dispatch mechanics.
- [x] Repeat Local Chat, projectless Work, Project-backed Work, approval,
  interruption, compaction, and Harness snapshot acceptance. Done: the full
  unit/integration/runtime-contract matrix preserves the Phase 1-2 acceptance
  contract; lean process tests cover real workspace execution, approvals,
  restart restoration, and Harness validation; `pnpm dev` and the complete
  product/settings walkthrough pass on the final composition.

### Phase 4 - Repair package-boundary and architecture guardrails

- [x] Replace the public SDK's relative Cloud source imports. Done: supported
  `@openpond/cloud` subpaths and an explicit bundled-source declaration replace
  `../../cloud/src` coupling.
- [x] Extend dependency validation for relative package escapes. Done: the
  checker resolves production relative imports to the most-specific workspace
  owner and requires a supported declared boundary.
- [x] Add a focused package-composition test. Done: `@openpond/app-server`
  composition and JSONL shutdown are covered, and its manifest admits only
  `@openpond/agent-runtime`; Phase 2 adds the dedicated placement and process
  proofs.
- [x] Document the distinct responsibilities of `@openpond/runtime`,
  `@openpond/agent-runtime`, and `openpond-agent-sdk`. Done: the package map and
  naming finding preserve the three separate concepts.

### Phase 5 - Begin hosted adoption

- [ ] Publish a CLI version containing the lean app-server entrypoint.
- [ ] Install the pinned CLI in the Work sandbox image.
- [x] Define the sandbox process transport and health/readiness contract. Done:
  the sandbox supervisor owns JSONL stdio and validates initialize,
  capabilities, and Harness state; no separate network listener is required.
- [ ] Preserve the Local acceptance matrix and pass hosted no-Project Work
  before adding Project-backed Development.

## Validation

- Passed: `pnpm run dependencies:check` reported all 21 workspace projects and
  direct plus relative cross-package source imports valid.
- Passed: `pnpm run structure:check` reported 1,249 production modules, 1,907
  handwritten files, and zero runtime/openpond cycles.
- Passed: `pnpm run cycles:server-runtime` reported 130 modules, 262 local
  edges, and zero cycles.
- Passed: `pnpm run reachability:check` reported 1,185 production modules
  reachable from 123 supported roots, including package `bin` targets.
- Passed: focused App Server, Agent Runtime, SDK, managed training, provider,
  Labs, artifact, and training compatibility tests.
- Passed: `pnpm run test:python` completed all 38 retained Local worker tests.
- Passed: `pnpm run test:unit` completed 371 files and 1,837 passing tests with
  one intentional skip.
- Passed: `pnpm run test:integration` completed 35 integration tests, including
  app-server JSON-RPC, restart recovery, and CLI process boundaries.
- Passed: `pnpm run test:contract` completed 42 Node contract tests plus all 33
  Agent SDK tests.
- Passed: App Server tests, Agent Runtime check/protocol generation/build, SDK
  check/build/dry-pack, web/CLI release builds, and all six release tests.
- Passed: `tests/app-server-lean-composition.test.ts` proves real Work command
  execution in the sandbox workspace, forbidden-constructor exclusion, JSONL
  approval resolution, restart restoration, and Harness release validation.
- Passed: the built and packed public CLI starts `openpond app-server` from an
  unrelated working directory, reports `hosted_work`, returns a valid Harness
  snapshot, emits only JSONL on stdout, and exits cleanly on EOF.
- Passed: the Refiner/Harness focused suite completed 42 tests, the Harness
  public API test passed, and the live Harness page showed the current release,
  zero pending reviews, and Refiner-backed applied history.
- Passed: clean-artifact `pnpm run build:sdk`; the SDK `prebuild` first emits
  its private bundled Cloud dependency and no longer depends on cached `dist`.
- Passed: upgrade-read regression coverage for retired Fireworks serving
  lineage, Prime model defaults, and hosted-BYOK/managed readiness classes.
- Passed: real `pnpm dev` launched the server, Vite renderer, and Electron;
  bootstrap returned 200 against the existing Local database after the read
  normalizers were repaired.
- Passed: final browser walkthrough of New Task, Chat/Work mode switching,
  Schedule, Outputs, Apps, Models, Tasksets, Serving, Usage, Account, Harness,
  Compute, and Training. The centered plus-icon New Task control renders as
  intended; retained Local Python/TRL runtimes are visible in Compute; no Prime
  or Fireworks controls returned.
- Passed previously: PR #71 unit, integration, runtime-contract,
  quality/build, release-artifact, and aggregate GitHub checks.

## Open Questions

- No architecture decision remains open for the code boundary. Local HTTP
  embeds `@openpond/app-server` in-process; hosted Work supervises the dedicated
  JSONL process.
- The remaining choices are operational: which CLI version to publish and pin,
  where the sandbox image mounts durable app-server state, and which staging
  environment will provide the first hosted no-Project Work acceptance proof.

## Progress Log

- 2026-08-07: Restored the uncommitted Python/local-training deletion in full.
  Confirmed the active change keeps Local training, inference, Compute settings,
  `@openpond/trainer-local`, schema generation, and Python CI coverage.
- 2026-08-07: Audited the post-PR #71 package graph, runtime composition,
  production entrypoints, package boundaries, tool registry, agent-only boot,
  and source structure. Recorded the distinction between the completed Local
  extraction and the then-pending lean executable boundary.
- 2026-08-07: Removed Prime and Fireworks integration surfaces plus the stale
  packaging folder while retaining Python/local training and managed RL.
- 2026-08-07: Added `@openpond/app-server`, converged executable tool catalog
  ownership, repaired SDK package imports, and enforced relative package-root
  boundaries. The lean placement adapter remains the hosted launch blocker.
- 2026-08-07: Ran the real Desktop development shell and screen-by-screen UI
  audit. Repaired clean-CI SDK build ordering and existing-state bootstrap for
  retired Fireworks lineage, Prime defaults, and hosted readiness classes;
  added focused upgrade regression tests and confirmed the full product shell
  loads against the retained Local database.
- 2026-08-07: Replaced the full-Local `app-server` boot path with a dedicated
  `hosted_work` composition, direct sandbox workspace tools, focused connected
  apps, shared typed Agent Runtime ports, and a separate bundled executable.
  Fixed the approval-registration race exposed by fast JSONL resolution.
- 2026-08-07: Added composition/source guards, real command and approval tests,
  restart/Harness restoration coverage, package-bin reachability roots, and an
  installed-artifact JSONL smoke. Re-ran the complete unit, integration,
  contract, Python, Agent Runtime, App Server, Refiner, and release suites.
- 2026-08-07: Repeated the live `pnpm dev` product walkthrough through Chat,
  Work, Schedule, Outputs, Apps, Models, Tasksets, Serving, Usage, Account,
  Harness, Compute, and Training. Confirmed Refiner history and retained Local
  Python training remain healthy while the hosted composition excludes them.
