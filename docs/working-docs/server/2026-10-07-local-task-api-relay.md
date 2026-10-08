# 2026-10-07 Native Local Task API Relay

Status: Native implementation and actual packaged Codex relay continuity verified; remaining desktop UI/lifecycle and parent capacity acceptance pending.

Latest checkpoint: 2026-10-08. Live staging verifies signed Native catalog/admission, duplicate and lost-receipt recovery, and persistent Off denial. An isolated actual AppImage captures the QA owner, retains one Codex thread across remote follow-up, staging web follow-up, steering, stop, supported approval and process restarts. Staging web observes retained messages and preserves an unsent draft across disconnect/reconnect. Live qualification caught and fixed hello lease encoding, signed Off targeting, initial viewer renewal, provider/local approval identity and terminal approval lifecycle. Latest targeted boundary suites, server project compiler, refreshed Linux packaging and package inventory pass. New-task web navigation, final Off/logout, authenticated native desktop UI and parent capacity acceptance remain pending; native iOS verification is owner-deferred.

Related docs:

- [Cross-repository staging spec](../../../../sandbox/docs/staging/2026-10-07-local-task-api-relay.md)
- [Canonical relay architecture and wire contract](../../../../sandbox/docs/working-docs/gateway/2026-10-07-local-task-api-relay.md)
- [Ponder conversational orchestration](../../../../sandbox/docs/working-docs/agent-harness/2026-10-06-ponder-conversational-orchestration-and-qualification.md)
- [Desktop navigation and local messaging](../ui-ux/2026-10-05-desktop-navigation-and-local-messaging.md)

## Summary

The signed-in local server automatically maintains one outbound connection for its active installation/profile unless the owner has disabled Remote access. Web and iOS can discover eligible account-owned tasks, read history/live output and issue supported controls through the Sandbox API. Opening or closing a desktop pane has no effect on the relay while its local server is alive. Local execution and provider credentials stay on the owning machine.

The Sandbox working doc owns shared protocol, retention, limits, API, hosted web/iOS and release acceptance. This Native companion owns local implementation boundaries and qualification. Do not fork wire-contract decisions here.

## Current Implementation

- [Generic lifecycle](../../../apps/server/src/remote-relay/manager.ts), [installation](../../../apps/server/src/remote-relay/installation.ts), [persistent preferences](../../../apps/server/src/remote-relay/preference.ts), and [Settings](../../../apps/web/src/components/settings/AccountRemoteAccessSettings.tsx) implement automatic account enrollment, durable Off and device management.
- [Contract synchronization](../../../scripts/sync-remote-device-contract.mjs) generates [Native protocol](../../../packages/contracts/src/remote-device.ts) from the canonical Sandbox source with a content hash and check mode.
- [History projection and fragment paging](../../../apps/server/src/remote-relay/history.ts), [canonical output references](../../../apps/server/src/remote-relay/output-refs.ts), and [artifact publication](../../../apps/server/src/remote-relay/artifacts.ts) bound wire/cache usage while preserving logical messages and canonical file ownership.
- [Signed admission](../../../apps/server/src/remote-relay/admission.ts), [original-session executor](../../../apps/server/src/remote-relay/executor.ts), [SQLite receipt/authority records](../../../apps/server/src/store/store-task-inbox.ts), and the final turn-runner guard retain original provider/workspace identity and reject expired, revoked or changed-owner authority.
- [Ponder caller client](../../../apps/server/src/openpond/ponder-desktop-client.ts) and [runtime](../../../apps/server/src/openpond/ponder-desktop-runtime.ts) consume pushed offers and reconcile only retained original operation IDs through the generic caller channel. General Remote access Off remains separate from bounded Ponder obligations.

## Initial Code Review

Reviewed 2026-10-07 at Native HEAD `1cc2bf61af446975c058a35ed45f793eef095bb2`, including dirty source; no runtime qualification was performed.

- [Ponder installation](../../../apps/server/src/openpond/ponder-installation.ts): persistent Ed25519 installation key. Extract reusable installation identity without resetting the existing Ponder binding.
- [Ponder desktop client](../../../apps/server/src/openpond/ponder-desktop-client.ts), [runtime](../../../apps/server/src/openpond/ponder-desktop-runtime.ts), [manager](../../../apps/server/src/openpond/ponder-desktop-manager.ts): captured account scope, signed requests, catalog and command reconciliation. Current polling suspends when scoped obligations settle; remote enrollment requires its own independent lifecycle.
- [Runtime event bus](../../../apps/server/src/runtime/runtime-event-bus.ts), [event routes](../../../apps/server/src/api/routes/event-routes.ts), [store](../../../apps/server/src/store/session-store.ts): durable sequences, catch-up and batching provide the event source. Add a scoped publication adapter rather than forwarding all events.
- [Local message service](../../../apps/server/src/runtime/task-inbox/local-managed-messaging.ts), [local message routes](../../../apps/server/src/api/routes/local-managed-message-routes.ts): original-session capability checks and idempotent admission; HTTP routes are intentionally loopback-only.
- [Session routes](../../../apps/server/src/api/routes/session-routes.ts): canonical task creation, turn input, interruption and approval services. The relay must reuse these underlying runtime operations with explicit remote authority.
- [Local messaging contracts](../../../packages/contracts/src/local-managed-messaging.ts), [Ponder contracts](../../../packages/contracts/src/ponder-desktop.ts): useful type/revision patterns, currently distinct authority contracts.
- [Existing event coverage](../../../tests/runtime-event-bus.test.ts), [event stream coverage](../../../tests/web-event-stream.test.ts), [task inbox coverage](../../../tests/task-inbox-turn.test.ts): retain meaningful history/concurrency coverage and extend real boundaries where the relay adds new failure modes.

## Product Decision

Provide one **Remote access** setting in the existing account/connection UI, on by default while signed in, showing the account/team, source computer, connection status, last successful contact and off/unlink control. No enrollment wizard or per-project setup is required. Explain that eligible account-owned tasks are available through OpenPond and fetched history may be cached for 24 hours. A deliberate off choice persists for the account/profile across restart, upgrade and logout/login; remote unlink also blocks automatic re-enrollment until deliberately re-enabled locally. Provider keys and the root local API token remain local.

Place this in **Settings → Remote access**, with **This computer** highlighted and **Your computers** using the same account device directory as web Settings. Include rename, last seen/catalog sync, open tasks, off and remove; allow local re-enable and retry for this computer only. Follow the parent spec's connection-state definitions and revocation/removal semantics. Distinguish connection status from an individual provider's ability to accept commands. Show a compact source/availability label on task headers, and use text as well as status color. This device-management surface does not require bringing hosted conversations into the desktop task list.

The default grant covers existing and future tasks/projects attributable to the active account/profile. Never transfer another account's ownership during login or expose tasks with unresolved ownership. Web and iOS keep their existing shared conversation experience; this release adds local task sources. Bringing hosted web/iOS conversations into desktop is a separate later UI integration, not a prerequisite.

Source tasks remain local and retain their existing provider/native session identity. Read-only imported conversations advertise read capability only. All runtime controls use observed capability and target revisions. Supported remote approval responses retain the original local approval policy and exact approval identity.

Remote access requires the local server to remain running. The local app need not keep a specific pane open. A standalone local server uses the same identity/grant lifecycle. Installing an OS background service or preventing sleep is outside this delivery.

## Implementation Shape

### Focused modules

Create a focused `apps/server/src/remote-relay/` area, split into connection lifecycle, enrollment/grants, catalog, transcript projection, subscription/replay, command admission and receipt recovery. Add only composition wiring to `index.ts` and existing lifecycle modules. Keep provider-specific readiness inside current provider/runtime services.

Use the shared versioned relay schemas in `packages/contracts` through the selected cross-repository distribution path. The existing Ponder client can reuse generic installation/signing utilities; preserve separate Ponder-origin and remote-human authorization records. Do not change `authority: user_click` into an unauthenticated trust marker or bypass loopback route guards.

Follow the parent's [general device architecture](../../../../sandbox/docs/working-docs/gateway/2026-10-07-local-task-api-relay.md#architecture-decision-general-device-relay-with-extracted-runtime-services) and [Ponder integration review](../../../../sandbox/docs/working-docs/gateway/2026-10-07-local-task-api-relay.md#ponder-integration-review-and-shared-ownership). Build a Ponder-independent connection manager and operation contract; extract shared canonical admission/recovery services, preserving typed caller provenance and existing durable identities. Move useful desktop executor/catalog/bounded-inspection code into focused generic modules and replace Ponder-coupled wrappers. Do not widen the old Ponder operation schema with optional fields or make a fake Ponder binding for ordinary remote use. Ponder-linked result discussion and completion dependencies remain separate domain logic. Cut over after outstanding pending/uncertain polling operations, unsettled admitted-work receipts/results and authorized completion dependencies are accounted for. Preserve original session/receipt identities and long-running provider work; retire old endpoints/manager without a second active claimer or fallback branch. Preserve settled historical records without bulk backfill or a general migration framework; broader Ponder conversation, memory and supervision changes stay in its focused spec.

### Connection ownership

The local server owns automatic enrollment and the socket. Check the persisted account/profile preference and hosted unlink tombstone before enrollment; only a deliberate local re-enable can clear an explicit disable. Capture owner/team/profile at connection creation; changes synchronously disable local remote admission, close subscriptions, clear publication buffers and revoke hosted scope before a new owner can connect. One local process owns the profile relay using a process lock plus the hosted lease/fence. UI mounts cannot create connections or signing endpoints.

Use the parent's recorded enforced limits and security bounds. Its numeric timer/quota values are initial tuning proposals; finite expiry, bounded queues, revocation and durable recovery remain mandatory. The agreed 24-hour fetched-history retention remains fixed.

Maintain authenticated presence while remote access is enabled, independently of Ponder obligations. Implement ticket acquisition, first-frame auth, negotiated capabilities, heartbeat, authorization renewal, jittered reconnect and drain using shared limits. Distinguish transport connected, grant valid and runtime ready; show truthful offline/error reasons.

Remote access Off disables general remote grants but does not prevent an explicitly initiated desktop Ponder request from making its existing bounded outbound exchange. The common connection manager may hold a request-scoped Ponder channel while those authorized obligations settle, without publishing a general remote directory or accepting direct web/iOS commands. Account/logout revocation applies to both. Do not translate all viewer stream events into Ponder context or confuse a read-only inspection with linked-result observation.

Do not allow relay congestion or failure to stall local turns. Persist commands/admission receipts through the canonical store and bound volatile outgoing data; detailed stream loss triggers replay/resync. Wire shutdown into the existing lifecycle so new remote admissions stop before closing the socket and draining receipt writes.

### Shared catalog and history

Filter by the persisted local grant before producing any catalog entry, history page or event. Qualify every ID by installation/profile and preserve source provider identity. Publish initial catalogs in pages and subsequent changes as revisioned patches. Capability updates include import-only, unavailable provider, pending approval, closed task and workspace changes.

Build an allowlisted remote projection of user-visible canonical messages and tool activity. Obtain a snapshot watermark and replay boundary from durable storage; never use only live renderer state. Preserve event IDs and history generation, page consistently, and apply the canonical snapshot/live contract. Send detailed data only for active subscriptions, with bounded concurrency and explicit oversized/truncated-output presentation.

Resolve artifacts through existing task attachment/output ownership. Accept opaque scoped artifact IDs only. Explicit remote fetch can upload an allowed object through a short-lived hosted upload grant; symlink/path escape and unshared-file access remain denied. Do not expose the current localhost signed-resource URL as a usable remote URL.

### Admission and recovery

Validate each command's hosted authority, local grant/revision, installation/profile, lease fence, expiry, target capabilities and operation preconditions before canonical admission. Persist the remote command ID and payload hash with the local input/session/approval receipt. A repeated request recovers that mapping before checking revisions that the original action already changed.

For task creation, reserve identity before provider start so reconnect cannot create a second session. For follow-up/steering, reuse the task inbox. For stop and approval resolution, preserve exact turn/request identity and durable outcome. If the original runtime cannot prove whether a provider accepted an operation, report reconciliation/uncertainty rather than executing again.

Reuse one durable admission mapping for commands affecting a canonical input; do not introduce competing Ponder and remote executors. Provider processes and local tools continue to be owned by existing runtime composition. Publish receipts independently of viewers and retain them until hosted acknowledgment. Treat live socket delivery as a wakeup, not as durable completion.

## Boundaries

No public local port, token-bearing remote URL, generic HTTP/shell proxy, duplicate runtime, automatic cloud migration or sharing with other users. No weakening the existing Ponder human-origin checks. Remote read access does not enable conversation collection/training. A local-only route stays local-only even after relay enrollment. Hosted conversations appearing in desktop remain outside this delivery.

## Phases

### Phase 1 — Shared contract and enrollment

- [x] Finalize shared schema distribution and integrate a separately persisted remote grant with existing installation identity. Done: generated canonical contract, retained installation identity and owner-scoped preference/SQLite authority.
- [x] Map/extract existing Ponder catalog, inspection, executor and receipt recovery behind typed caller adapters, preserving existing origin validation and operation identities. Done: generic ownership/admission services and original signed Ponder caller RPC; retained runtime boundary suite passes.
- [ ] Establish a generic connection/operation core with no Ponder-domain dependency and validate a signed-in server that has no Ponder binding.
- [ ] Implement automatic signed-in enrollment, persistent Remote access off/unlink state, connection status, profile process ownership and account/team/revocation fencing.
- [x] Implement Settings → Remote access with This computer/Your computers, account-scoped directory reads, connection/sync status and revision-aware device controls matching web. Done: source UI and local-only signed device management route; live UI qualification remains Phase 4.
- [x] Establish the authenticated device connection against canonical staging and prove reconnect/shutdown behavior. Actual isolated packaged restart retains installation, device, session and Codex thread.

### Phase 2 — Publication and viewing

- [ ] Publish only shared catalog entries with paginated snapshots, patches and accurate capabilities.
- [ ] Implement durable snapshot/live replay, generation changes, backpressure and on-demand artifact publication.
- [ ] Prove hosted web and iOS see matching local history while local work continues through viewer disconnects.

### Phase 3 — Remote human controls

- [x] Integrate typed start/follow-up/steer/stop/approval commands through canonical local services and persisted admission receipts. Done: executor and SQLite authority/receipt guards; remote permit and lost-ack restart boundary test passes.
- [ ] Prove lost acknowledgments, duplicate delivery, crash recovery, expiration and simultaneous controls do not repeat or redirect actions.
- [ ] Qualify supported providers against original sessions and expose explicit capability limits for unsupported/import-only targets.
- [ ] Prove direct-user and desktop-Ponder callers through one connection owner, request-scoped Ponder behavior when Remote access is Off, and recovery during polling retirement without duplicate admission.

### Phase 4 — Web/desktop qualification

- [ ] Complete the web/desktop portions of the parent acceptance matrix with the hosted web app at `https://staging.openpond.ai` and the installed desktop app locally against the canonical staging relay, including task discovery, live history, remote controls, Settings, sleep/resume, account switch and unlink. Use `pnpm dev` for local desktop/server testing and reuse an existing process; record real persisted admission/recovery evidence.
- Deferred: native iOS device/build qualification for owner verification, including background/resume and push deep links. This does not block the web/desktop Phase 4 checkpoint and must be completed before claiming native mobile completion.
- [ ] Record exact source/artifact identities and observed stream/command latency; contribute Native-side queue, replay and admission/recovery metrics to the parent's declared launch-capacity qualification. Large-fleet benchmarking remains deferred beyond initial launch; do not claim unmeasured supported capacity.
- [ ] Verify packaging/startup, shutdown and version mismatch behavior before enabling the hosted release for users.

## Validation

Current source evidence:

- Passed: `node scripts/run-typescript.mjs tsc -b apps/server apps/web --pretty false` after the initial source implementation and diagnostic fixes. Passed again after final contract/fragments/reconciliation/history-incarnation convergence.
- Passed: `pnpm exec vitest run apps/server/src/remote-relay/admission.integration.test.ts apps/server/src/openpond/ponder-desktop-runtime.test.ts apps/server/src/work/work-output-service.test.ts` — three files, six tests.
- Passed after fragment/reconciliation edits: `pnpm exec vitest run apps/server/src/openpond/ponder-desktop-runtime.test.ts apps/server/src/remote-relay/history.test.ts` — two files, three tests. The large Unicode snapshot test proves exact text and stable fragment resumption; the runtime test proves original inspection/owner fencing.
- Passed: `node scripts/sync-remote-device-contract.mjs` and final `pnpm run build:contracts`. The final selective server/web check also passed after convergence.
- Passed final boundary batch: `pnpm exec vitest run apps/server/src/remote-relay/history.test.ts apps/server/src/openpond/ponder-desktop-runtime.test.ts apps/server/src/remote-relay/admission.integration.test.ts apps/server/src/work/work-output-service.test.ts` — four files, eight tests. Added rollback-incarnation coverage. `git diff --check` and all 36 Native companion local links passed.
- Live evidence: `evidence/remote-device-native-staging.json` and `evidence/remote-device-packaged-provider-staging.json` distinguish isolated admission from actual packaged provider execution. Codex remote follow-up/web follow-up, steering, exact-turn stop, stale prior-turn rejection, supported approval, duplicate approval receipt and restart continuity pass. The parent records actual staging web UI observation.
- Pending: web New task/start navigation, final packaged Off/logout/account-switch/unlink, authenticated native desktop Settings/task UI, sleep/resume and measured parent launch capacity. Native iOS device/build qualification remains owner-deferred.

An isolated actual packaged app was launched for QA; production account/profile and provider credentials remain unchanged. Use `https://staging.openpond.ai` for all web qualification. Use `pnpm dev` only for local desktop/server qualification and reuse a running app. The ignored Native companion must be explicitly included in the coordinated source commit.

Implementation validation is selective: use existing diagnostics and the smallest relevant package/project check for changed shared types, public interfaces, module boundaries or a concrete type error. Use `pnpm run typecheck` or a package script when justified; custom compiler checks use `node scripts/run-typescript.mjs tsc <args>` from the repository root. Batch related edits and reuse an active check. Do not require full-repository typechecking or builds for documentation/copy/styling, or run a build as a substitute for a skipped typecheck. Select relevant retained event/inbox/admission boundary suites by affected risk, and test locally with `pnpm dev`; reuse an already running app. Record checks run and skipped accurately. Validate installed server/desktop lifecycle using the existing packaging flow once the feature is implemented. Select tests for actual authorization, history loss and duplicate-admission failure stories, not UI prose or implementation wiring.

Run the [canonical end-to-end acceptance matrix](../../../../sandbox/docs/working-docs/gateway/2026-10-07-local-task-api-relay.md#validation) against the hosted staging relay. Local mocks alone do not qualify network routing, device isolation, provider continuity or mobile lifecycle. Capture redacted receipt IDs and local persisted input/session counts for crash/retry scenarios, plus observed UI state for both viewers.

## Open Questions

- Shared wire distribution is resolved: canonical Sandbox source generates Native contract with hash/check mode. SQLite external file overwrite while the app holds an open database is unsupported; supported restart/observed sequence rollback changes the relay history incarnation. A restore that occurs outside these observable boundaries requires restarting the local server.
- Confirm which installed native provider versions support safe original-session steering, stop and approval response. Capability gaps must remain visible and cannot be disguised as successful remote controls.
- Confirm the existing server/desktop packaging path keeps installation identity stable during upgrades; changing the identity store requires an explicit one-time migration preserving Ponder authority.

## Progress Log

- 2026-10-07: Authored the Native companion after reviewing event, messaging, provider identity and Ponder exchange boundaries. No implementation or live qualification performed.
- 2026-10-07: Replaced manual opt-in with automatic signed-in attachment and persistent opt-out. Kept account ownership boundaries and deferred hosted-conversation presentation in desktop; added this behavior to parent acceptance requirements.
- 2026-10-07: Added desktop Settings device management matching web, and recorded the agreed durable directory/24-hour cache. UI and runtime implementation remain pending.
- 2026-10-07: Reviewed Ponder overlap and linked the parent's common transport/admission plan. Preserve originating-desktop authority, bounded inspection, result provenance, outstanding receipts and remote-off behavior; no current Ponder qualification scope or runtime behavior changed.
- 2026-10-07: Clarified clean device-domain replacement for the Ponder-bound connection/protocol, with extraction of useful task execution/recovery code and bounded retirement of the old transport. No blanket runtime rewrite or permanent compatibility branch is planned.

- 2026-10-07: Made staging web and installed desktop acceptance explicit in Phase 4, preserving command/recovery and lifecycle boundaries. Deferred native iOS device qualification to owner verification; no live checks performed.

- 2026-10-07: Aligned with declared launch-capacity qualification, deferred large-fleet expansion and provisional numeric tuning values. Limited Ponder cutover to outstanding obligations and unsettled mappings while preserving admitted work. No implementation or runtime checks performed.

- 2026-10-08: Implemented Native generic relay, protected remote admission and Settings; replaced Ponder polling with original signed caller RPC and retained-operation reconciliation. Boundary suites pass as recorded above. Final selective checks pass; live staging/desktop qualification remains pending; no release or capacity claim.

- 2026-10-08: Owner explicitly requires web qualification only at `https://staging.openpond.ai`; local installed desktop/server still connects to the canonical staging API. Prepared a no-provider isolated Native manager/executor/SQLite staging admission harness without switching the active production account. The pre-deployment attempt reached no relay routes (404), so no live admission qualification is claimed from that attempt.

- 2026-10-08: Live staging Native canonical admission proof passes authenticated enrollment/catalog, signed follow-up admission, duplicate idempotency, lost-receipt store reopen recovery, and persistent Off with hosted denial; temporary device removed. It caught and fixed optional hello lease fields and the signed disable target. Evidence: `evidence/remote-device-native-staging.json`; provider invocations are zero, so this does not qualify provider continuity or desktop UI. Packaged QA process separately establishes an owned Codex session and retained provider thread; continuity/UI acceptance remains pending.

- 2026-10-08: Actual packaged Codex proof retains the original thread through remote and staging-web follow-up, steering, supported web approval and restarts. Exact-turn stop is applied; stale prior-turn and competing approval requests reject safely; duplicate approval recovers the same applied receipt. Fixed provider/local approval identity, terminal cancellation, late pending callbacks and viewer renewal before snapshot. Two focused boundary files (three tests) and the server-only compiler pass; Linux AppImage/deb and package inventory refreshed. Authenticated native desktop UI remains unqualified.

- 2026-10-08: Added managed OpenPond original-session support using its canonical local task/history and exact captured account/profile/team readiness. Remote starters now use the canonical create-session schema, omit absent model references and preserve explicit provider/model configuration; malformed starters are excluded and remote errors use safe codes. Four focused boundary files (18 tests), selective server compiler, Linux packaging and exact package inventory pass. Actual managed provider and web New task qualification remain pending coordinated staging checks.

- 2026-10-08: Actual staging-web managed OpenPond follow-up retains the original canonical task/model and marker with one remote input, two primary turns total and no tool events. New task admission retains one reserved task/input/turn; public-link navigation and catalog readiness are separately tracked. Native now publishes semantic control catalog revisions before corresponding live state events, with a real-socket ordering/no-token-refresh boundary and selective server compiler passing. CLI staging uses the current reachable build graph, excluding 118 historical hashes; six stage boundary tests and final Linux package inventory pass. Coordinated final restart/web controls/lifecycle proof and authenticated native UI remain pending.
