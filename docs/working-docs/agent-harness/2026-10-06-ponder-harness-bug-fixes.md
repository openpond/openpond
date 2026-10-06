# Ponder harness conversation and collector bug fixes

Status: confirmed open-source harness bugs implemented; source and boundary verification passed. This is separate from the remaining hosted-Ponder desktop tool bridge and real conversational delegation qualification.

Latest checkpoint: 2026-10-06. Source is committed as `e74218dba` on `feat/profile-evaluation-billing`; the existing desktop instance was restarted with `pnpm dev --no-watch`, and authenticated API plus renderer checks returned HTTP 200 with no active tasks. Removed the manual Ponder sender, restored reply actions, repaired native history eligibility/explanations and tool presentation, added durable peer message presentation, and corrected collector handling of empty OpenCode sessions and large Codex records. Final targeted verification has 45 passing tests and three opt-in live-provider skips. The collector package and desktop renderer build successfully. Native browser verification remains policy blocked; source and SQLite/HTTP proof do not establish rendered or model-selected orchestration success.

Related: [Conversational orchestration and realistic qualification](../../../../sandbox/docs/working-docs/agent-harness/2026-10-06-ponder-conversational-orchestration-and-qualification.md), [Desktop delivery](../ui-ux/2026-10-05-desktop-navigation-and-local-messaging.md).

## Summary and decisions

Fix confirmed defects in the existing harness, keeping the canonical hosted Ponder conversation, existing composer and original native sessions. Authenticated local message admission remains available. Removing its manual Ponder dropdown does not give the hosted model local tools: that scoped execution boundary remains unfinished.

A peer delivery receipt proves transport/inclusion, not an agent reply or task success. Origin comes from the durable TaskInput sender identity. Never relabel user-click messages as Ponder. Imported histories may accept a follow-up only after original-session continuation is qualified, with matching provider/folder binding, current readiness and no branch snapshot. Qualification changes invalidate stale new-send intents; acknowledged retries retain their original receipts.

## Current code review and implementation

- `packages/evals/src/connected-evidence/{contracts,normalize,imports}.ts`: the old 2 MiB JSONL line limit rejected valid Codex records inside the existing file budget. A line can now fit the 64 MiB decoded-file budget, which is checked before parsing. Raw acquisition and evaluator limits remain independent. A 2.3-million-character record is retained; the 2 MiB evaluator limit still rejects oversized evaluation context.
- `packages/evals/src/native-conversations/{readiness,history,collector}.ts`: an empty source session has a typed not-ready result, records skipped progress and awaits a source revision. It never becomes a fabricated training example or persistent source failure. Corrupt/schema-invalid histories still fail visibly.
- `apps/server/src/runtime/native-agents/history.ts`, `api/server-payloads.ts`: read-only explanations distinguish absent folder, disabled/unqualified agent and selected branch. Qualified originals retain their exact identity and avoid repeated capability probes.
- `runtime/task-inbox/{local-managed-messaging,target-revision}.ts`: qualified original native history is eligible for explicit local follow-up; unqualified histories, branch snapshots and imported Codex placeholders remain ineligible. Existing paused/approval guards and atomic target-revision admission remain authoritative.
- `runtime/task-inbox/runtime.ts`, `runtime/turn-runner.ts`: received and sent events retain the receipt and real peer identity. Settlement/rejection/recovery refresh both timelines; per-receipt serialization prevents stale pending events winning a settlement race. Follow-up projection markers require a real receipt for that session/turn.
- `apps/web/src/lib/chat-{messages,task-messages,native-history}.ts`: receipt revisions coalesce to one row, with accurate pending/included/resolved/error state. Original peer text replaces an internal follow-up wrapper. Retained Claude/OpenCode tool payloads project arguments, results and errors into existing activity UI without rewriting source evidence or stripping literal brackets/JSON.
- `components/chat/{MessageFooter,TaskMessageRow,Messages}.tsx`, `lib/chat-timeline-rows.ts`: all assistant replies show Copy, local timestamp and measured UTF-8 bytes; available KV remains a separate metric. Peer messages show source/destination links and accurate transport status.
- `components/ponder/PonderDesktopPanel.tsx`: removes alternate local-target selection/submission while preserving canonical chat, recommendation edit/send and existing draft guards. Deleted the two orphan manual-sender components and their CSS.

## Boundaries

No GPU, training run, historical export, fresh QA account, production deployment or paid model call was started. No new general remote-control tunnel or messaging authority was added. Hosted-Ponder local task creation/dispatch/returns and real Opus/Codex scenarios remain in the linked parent spec. The user's exact bracketed row and composer width report are not reproduced by source fixtures. Native visual access was explicitly blocked; no alternate CDP/browser/OS transport was used.

## Phases

- [x] Repair collector acquisition. Done: real SQLite OpenCode lifecycle test skips an empty session, then admits its completed request once under the same identity; large Codex evidence retains integrity and evaluator limits.
- [x] Repair original-session eligibility and explanations. Done: source/identity tests plus authenticated HTTP and atomic SQLite admission checks preserve disabled, stale, branch, approval and paused boundaries.
- [x] Repair reply and peer message presentation. Done: shared source/build checks; SQLite-to-timeline checks prove retry deduplication, two-sided receipt updates, follow-up wrapper removal and crash uncertainty without replay.
- [x] Repair recognized retained tool presentation. Done: actual native-format import, stored history reopen and chat projection preserve text, tool arguments/results and evidence hashes. This is fixture proof, not the reported live row.
- [ ] Visually inspect footers, Copy, attribution links, tool details and draft behavior in the running desktop when local browser policy permits.
- [ ] Complete the parent spec's scoped hosted-Ponder execution/return bridge and real conversational scenarios; do not mark these complete from transport tests.

## Validation

- `pnpm typecheck`: passed.
- `pnpm exec vitest run tests/task-inbox.test.ts tests/task-inbox-turn.test.ts tests/native-history-sidebar.test.ts tests/native-agent-boundaries.test.ts packages/evals/test/collector-lifecycle-boundary.test.ts packages/evals/test/connected-evidence-boundary.test.ts packages/evals/test/native-history-boundary.test.ts --maxWorkers=1`: 45 passed, three opt-in live-provider tests skipped. Covers real SQLite and authenticated HTTP boundaries; no CSS/prose/icon snapshot tests added.
- `pnpm --filter @openpond/evals build`: passed; runnable package regenerated.
- `pnpm run build:web`: passed; existing large-chunk advisory remains.
- Final changed-boundary rerun: `pnpm typecheck && pnpm exec vitest run tests/task-inbox.test.ts tests/native-history-sidebar.test.ts --maxWorkers=1 && git diff --check` passed (17 tests), including both Claude and OpenCode imports and no peer-title disclosure after access changes.
- `git diff --check`: passed.
- Authenticated running `/v1/bootstrap`: HTTP 200, 881 idle and 30 failed sessions, no active session or pending approval at the restart check. No private history, credentials or provider tokens are retained in evidence.

## Open questions

Native rendered proof, the exact user-reported bracket/width rows and model-selected hosted-Ponder local orchestration remain unverified. These are explicit acceptance gaps, not successful tests. Deployment and release of these native changes are separate from the already completed Sandbox card staging release.

## Progress log

- 2026-10-06: User resumed confirmed open-source harness bug fixes. Reviewed existing source and parent qualification spec, implemented repairs and completed bounded verification without training or provider calls.
