# Agent Runtime Phases 1–2 Local Acceptance (In Progress)

This ledger records the Local-only acceptance evidence for the shared agent
runtime extraction and app-server protocol. Hosted Chat, hosted Work, sandbox
installation, and control-plane transport remain Phase 3 or later.

## Implementation boundary

- `@openpond/agent-runtime` is a private workspace package. It owns canonical
  hashing, event/checkpoint/effective-surface contracts, provider-round
  sequencing and exhaustion, tool catalog projection and dispatch, prompt
  materialization, the versioned JSON-RPC contract, the transport-neutral
  thread/turn service, privacy-safe lifecycle telemetry, generated
  client/schema artifacts, ordered JSONL transport, the provider-neutral
  compaction threshold/lifecycle policy, canonical event persistence, and
  durable checkpoint creation. The provider-specific round body and full
  compaction execution algorithm are still being extracted from `apps/server`.
- `@openpond/harness` owns the portable Refiner decision schema, bounded prompt,
  streaming parser, timeout, repair behavior, deterministic trigger/detour
  detection, bounded evidence projection, revision checks, stable IDs, and
  overlay/workspace comparison helpers. SQLite artifact lookup, queues,
  provider credentials, filesystem materialization, UI composition, and release
  selection remain Local host concerns.
- `openpond app-server` launches the existing app-server in agent-only mode over
  JSONL stdio. It does not listen on HTTP or start the Local scheduler. Desktop
  continues using the HTTP/static-web adapter; its create/start/interrupt and
  approval routes now call the same `AgentRuntimeHost` service used by JSON-RPC
  instead of independently invoking the old lifecycle functions. Agent
  lifecycle responses identify that adapter with
  `X-OpenPond-Agent-Transport: transitional-http-adapter`.
- The former Desktop scenario command is `openpond desktop-test`, leaving
  `openpond harness` available for release inspection and conformance semantics.

Milestone commits on `feat/app-server-runtime-convergence`:

- `7556d1b` — Phase 0 characterization fixtures and parity hashes.
- `2cc3c8a` — shared runtime boundary and portable Refiner extraction.
- `faa5a29` — Local app-server JSON-RPC protocol, generated artifacts, CLI
  spelling, and shared HTTP/RPC runtime composition.
- `b2e86b9` — handshake ordering, process/resilience metrics, preliminary
  compaction lifecycle adapter, and initial Local acceptance ledger.
- `90cd745` — shared Local runtime service ownership, canonical event and
  checkpoint adoption, provider-round controller, and privacy-safe telemetry.
- `3faae28` — portable Refiner detector/evidence/revision helpers moved into
  `@openpond/harness`, leaving SQLite and filesystem concerns in the host.

These commits are the initial draft baseline, not proof that the ownership
extraction is complete.

## Automated protocol and recovery evidence

The following gates use Node 24.18.0 and real temporary SQLite/Harness stores:

- `tests/agent-app-server-rpc.test.ts` runs a two-turn projectless Local Work
  thread through JSON-RPC, observes streamed events, validates the pinned
  Harness release and tool-catalog hash, exercises the transitional compaction
  adapter, interrupts a real in-flight provider stream, and reopens the same
  thread and Harness selection after process restart.
- `tests/agent-app-server-cli.test.ts` starts the public `openpond app-server`
  command as a child process, performs the initialization/capability/Harness
  handshake over clean JSONL, and proves agent-only mode emits no HTTP-ready
  banner.
- `packages/agent-runtime/test/protocol.test.ts` covers incompatible versions,
  initialization ordering, generated-client dispatch, concurrent
  turn/interruption requests, pre-initialization event buffering, ordered
  writes, and backpressure.
- `tests/agent-runtime-phase-zero.test.ts` keeps all Phase 0 Local and hosted
  characterization hashes pinned and retains the real failure-to-avoidance
  Harness gate.

Measured on 2026-08-06 with the deterministic scripted provider:

| Measurement | Result |
| --- | ---: |
| `openpond app-server` process to initialize response | 1,155.06 ms |
| JSON-RPC turn request to first assistant delta | 73.23 ms |
| Transitional manual compaction, including persisted events | 17.64 ms |
| In-flight provider cancellation to interrupted response | 2.04 ms |
| SQLite/Harness restart and thread-resume readiness | 33.62 ms |
| Buffered JSONL event burst | 500 events in 1.35 ms (371,333 events/s) |

These numbers measure local runtime/transport overhead with deterministic model
output. They are not claims about network-model latency.

## Live Desktop acceptance

The in-app browser was used against the running Local app at
`http://127.0.0.1:17876/`; no sandbox or hosted execution was selected.

- The new-task composer visibly exposed `Select Project` and `Working in:
  Local`.
- A projectless Work task created and verified
  `phase2-live-acceptance.txt` in its app-managed task workspace. A follow-up
  correction changed the exact content in the same file. The real UI reported
  9 seconds and 7 seconds for those turns.
- Background Refiner review ran for both completed turns. The ordinary
  correction completed in 4.5 seconds and correctly returned no action rather
  than adding a one-off rule to Harness.
- An explicit reusable correction invoked the prompt route. Refine validated and
  atomically advanced release `e001872197` to `c9fceabd8b` at channel revision
  9. Settings showed the exact validation receipts.
- `View release diff` opened the existing right sidebar (`Workspace diffs`,
  `Files`) and displayed the exact `instructions/system.md` addition.
- A genuinely fresh projectless Local Work task admitted the new immutable
  release and followed the new two-line receipt behavior, proving causal
  next-task application rather than same-turn prompt echoing.
- The temporary test rule was rolled back through the UI. The channel advanced
  to revision 10 and selected the prior immutable release `e001872197`.
- A project-backed Work task selected the `openpond` project, visibly showed
  `Local checkout`, read `packages/agent-runtime/package.json`, and reported
  `@openpond/agent-runtime` / `private: true` without modifying source files.
- After wiring the shared prompt materializer and compaction lifecycle adapter,
  the reloaded final-source app completed a fresh projectless Local smoke with
  the exact response `LOCAL-RUNTIME-OK` and no file mutation.
- After the ownership audit, a fresh real Local Chat turn returned exactly
  `CHAT-RUNTIME-OK`.
- A projectless Local Work turn demonstrated workspace isolation by correctly
  refusing to treat the OpenPond checkout as its workspace. A corrected
  projectless test created, read, and deleted `runtime-acceptance.txt` in the
  app-managed workspace and returned exactly `PROJECTLESS-WORK-OK`; a host
  filesystem check confirmed the temporary file was absent afterward.
- A Project-backed Local Work turn selected `openpond`, visibly showed `Local
  checkout`, read `packages/agent-runtime/package.json`, and returned exactly
  `PROJECT-WORK-OK` without modifying source files.
- Structured server telemetry recorded the shared-service `thread/start` and
  `turn/start` started/completed pairs with correlation IDs and durations. It
  intentionally excludes prompts, tool arguments/results, file contents, and
  credentials.
- After the final runtime/checkpoint/Refiner-detector changes reloaded in the
  real server, a fresh Local Chat returned exactly `FINAL-CHAT-OK`. A fresh
  no-Project Local Work task created, read, and deleted
  `final-runtime-smoke.txt`, then returned exactly `FINAL-WORK-OK`; a host
  filesystem check confirmed the temporary file was absent.

## Repository verification

- TypeScript project build, Harness clean-consumer/package verification,
  source-structure, workspace-dependency, production-reachability, repository
  hygiene, and Node-toolchain checks passed.
- Root/CLI unit matrix: 376 of 377 files and 1,868 of 1,869 tests passed. The
  sole failure is the unchanged machine dependency exception in
  `local-image-tool-registry.test.ts`: ImageMagick `identify` is not installed
  (`spawn identify ENOENT`). The same exception exists in the Phase 0 baseline;
  CI installs ImageMagick.
- Integration matrix: 4 files / 35 tests passed.
- Node contract matrix: 42 tests passed.
- Agent SDK: 9 files / 33 tests passed.
- Production web build, CLI/package build, and installed CLI release matrix
  (1 file / 5 tests) passed.
- The post-audit matrix repeated these gates: 376/377 unit files and
  1,868/1,869 tests (only the same missing-ImageMagick exception), 4 integration
  files / 35 tests, 42 Node contracts, 33 Agent SDK tests, 5 installed release
  tests, Harness clean-consumer packing, source structure, dependency
  declarations, production reachability, repository hygiene, and Node-only
  toolchain checks.

## Local completion boundary

Phases 0–2 are not complete yet. Completion requires moving the remaining
provider-specific round body and full compaction execution algorithm behind
typed runtime host ports, followed by the same real Chat/Work/Harness matrix on
the final branch commit.
Phase 3 must consume that boundary without moving hosted provider credentials,
connected-app implementations, sandbox provisioning, or web product state into
`@openpond/agent-runtime` or `@openpond/harness`.
