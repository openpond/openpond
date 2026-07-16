# Desktop Harness Scenarios

Scenario files in this directory are run by `pnpm exec tsx scripts/desktop-harness.ts run`.
They can also be run through the CLI wrapper with `openpond harness desktop run <scenario...>`.

Implemented scenarios:

- `chat-two-turns.ts`: visible composer submission for a deterministic two-turn chat.
- `subagent-heartbeat-settings.ts`: Subagents Settings background-check cadence copy, bounds, save, and reload readback proof.
- `subagent-heartbeat-no-progress-wake.ts`: long-running child proof that a routine heartbeat interval updates diagnostics without waking the parent model before submission.
- `subagent-heartbeat-thread-scoped.ts`: no-goal child proof that watcher submission wake and Subagents details work from `parentSessionId` alone.
- `subagent-heartbeat-stale.ts`: required/optional stale policy proof with required parent wake and optional attention-only receipt.
- `subagent-visible-lifecycle.ts`: deterministic parent/child subagent lifecycle with parent activity rows, child-session linkage, and screenshot proof.
- `subagent-running-state.ts`: delayed child run with visible sidebar/activity running state and submitted-for-review proof.
- `subagent-handoff-parent-wake.ts`: child-to-parent handoff receipt, queued parent wake metadata, and child linkage proof.
- `subagent-watch-submission-wake.ts`: submitted-for-review child packet, watcher-queued parent lifecycle wake, and compact child result proof.
- `subagent-review-revision-loop.ts`: parent/reviewer needs-revision decision, delivered child correction, revised child packet, and final accept proof.
- `subagent-bounded-worker-contract.ts`: copy-on-write coding child proof with structured worker brief, repeated search steering evidence, isolated write, validation command, submitted-for-review status, and patch handoff.
- `subagent-blocked-approval.ts`: write-capable child isolation blocker with parent blocked activity and linked child row proof.
- `goal-scoped-subagent-details.ts`: active goal runtime plus running/submitted child state in the composer strip and right sidebar Goal details.
- `context-compaction-followup.ts`: manual OpenPond summary compaction status row, persisted summary event, usage record, and post-compaction composer follow-up.
- `new-model-end-to-end.ts`: networkless Cross-System Operations proof from deterministic worlds and baseline traces through Miner/Creator, GRPO plus SFT-bootstrap lineage, local fixture training, frozen evaluation, constrained normal chat tools, and a real desktop/server restart.
- `subagent-suite.ts`: the deterministic desktop regression suite for subagent additions.

Artifact convention:

- Default run artifacts: `tmp/desktop-harness/<iso-timestamp>/`.
- Per-scenario artifacts: `tmp/desktop-harness/<iso-timestamp>/<scenario-name>/`.
- Explicit runs should prefer `--artifacts-dir tmp/desktop-harness/<purpose>` and `--json tmp/desktop-harness/<purpose>/report.json`.
- Packaged runs require a prebuilt desktop app and should pass `--packaged --app <path>` or rely on standard `release/` candidates.

Use server APIs for setup-heavy state. Use real renderer actions only when the scenario is proving visible UX behavior.

Useful commands:

```bash
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/chat-two-turns.ts --isolated --json tmp/desktop-harness/chat-two-turns/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-heartbeat-settings.ts --isolated --json tmp/desktop-harness/subagent-heartbeat-settings/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-heartbeat-no-progress-wake.ts --isolated --timeout-ms 150000 --json tmp/desktop-harness/subagent-heartbeat-no-progress-wake/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-heartbeat-thread-scoped.ts --isolated --json tmp/desktop-harness/subagent-heartbeat-thread-scoped/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-heartbeat-stale.ts --isolated --timeout-ms 150000 --json tmp/desktop-harness/subagent-heartbeat-stale/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-visible-lifecycle.ts --isolated --json tmp/desktop-harness/subagent-visible-lifecycle/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-running-state.ts --isolated --json tmp/desktop-harness/subagent-running-state/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-handoff-parent-wake.ts --isolated --json tmp/desktop-harness/subagent-handoff-parent-wake/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-watch-submission-wake.ts --isolated --json tmp/desktop-harness/subagent-watch-submission-wake/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-review-revision-loop.ts --isolated --timeout-ms 180000 --json tmp/desktop-harness/subagent-review-revision-loop/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-bounded-worker-contract.ts --isolated --timeout-ms 150000 --json tmp/desktop-harness/subagent-bounded-worker-contract/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-blocked-approval.ts --isolated --json tmp/desktop-harness/subagent-blocked-approval/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/goal-scoped-subagent-details.ts --isolated --json tmp/desktop-harness/goal-scoped-subagent-details/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/context-compaction-followup.ts --isolated --json tmp/desktop-harness/context-compaction-followup/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/new-model-end-to-end.ts --isolated --timeout-ms 300000 --json tmp/desktop-harness/new-model-end-to-end/report.json
pnpm test:desktop:subagents
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/chat-two-turns.ts tests/desktop-scenarios/subagent-heartbeat-settings.ts tests/desktop-scenarios/subagent-heartbeat-no-progress-wake.ts tests/desktop-scenarios/subagent-heartbeat-thread-scoped.ts tests/desktop-scenarios/subagent-heartbeat-stale.ts tests/desktop-scenarios/subagent-visible-lifecycle.ts tests/desktop-scenarios/subagent-running-state.ts tests/desktop-scenarios/subagent-handoff-parent-wake.ts tests/desktop-scenarios/subagent-watch-submission-wake.ts tests/desktop-scenarios/subagent-review-revision-loop.ts tests/desktop-scenarios/subagent-bounded-worker-contract.ts tests/desktop-scenarios/subagent-blocked-approval.ts tests/desktop-scenarios/goal-scoped-subagent-details.ts tests/desktop-scenarios/context-compaction-followup.ts --isolated --timeout-ms 300000 --json tmp/desktop-harness/desktop-scenarios/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/chat-two-turns.ts --packaged --app release/linux-unpacked/openpond --json tmp/desktop-harness/packaged-chat/report.json
pnpm exec tsx scripts/desktop-harness-report.ts summarize tmp/desktop-harness/chat-two-turns/report.json tmp/desktop-harness/context-compaction-followup/report.json --json tmp/desktop-harness/release-proof/summary.json --markdown tmp/desktop-harness/release-proof/summary.md
pnpm --dir apps/cli cli harness desktop run tests/fixtures/desktop-harness/pass-scenario.ts --none --artifacts-dir tmp/desktop-harness/cli-wrapper --json tmp/desktop-harness/cli-wrapper/report.json
openpond harness desktop run tests/desktop-scenarios/chat-two-turns.ts --isolated --json tmp/desktop-harness/chat-two-turns/report.json
openpond harness desktop run tests/desktop-scenarios/chat-two-turns.ts --packaged --app release/linux-unpacked/openpond --json tmp/desktop-harness/packaged-chat/report.json
```
