# Desktop Harness Scenarios

Scenario files in this directory are run by `bun scripts/desktop-harness.ts run`.
They can also be run through the CLI wrapper with `openpond harness desktop run <scenario...>`.

Implemented scenarios:

- `chat-two-turns.ts`: visible composer submission for a deterministic two-turn chat.
- `subagent-visible-lifecycle.ts`: deterministic parent/child subagent lifecycle with parent activity rows, child-session linkage, and screenshot proof.
- `subagent-running-state.ts`: delayed child run with visible sidebar/activity running state and completion proof.
- `subagent-handoff-parent-wake.ts`: child-to-parent handoff receipt, queued parent wake metadata, and child linkage proof.
- `subagent-blocked-approval.ts`: write-capable child isolation blocker with parent blocked activity and linked child row proof.
- `goal-scoped-subagent-details.ts`: active goal runtime plus running subagent count in the composer strip and right sidebar Goal details.
- `context-compaction-followup.ts`: manual OpenPond summary compaction status row, persisted summary event, usage record, and post-compaction composer follow-up.
- `subagent-suite.ts`: the deterministic desktop regression suite for subagent additions.

Artifact convention:

- Default run artifacts: `tmp/desktop-harness/<iso-timestamp>/`.
- Per-scenario artifacts: `tmp/desktop-harness/<iso-timestamp>/<scenario-name>/`.
- Explicit runs should prefer `--artifacts-dir tmp/desktop-harness/<purpose>` and `--json tmp/desktop-harness/<purpose>/report.json`.
- Packaged runs require a prebuilt desktop app and should pass `--packaged --app <path>` or rely on standard `release/` candidates.

Use server APIs for setup-heavy state. Use real renderer actions only when the scenario is proving visible UX behavior.

Useful commands:

```bash
bun scripts/desktop-harness.ts run tests/desktop-scenarios/chat-two-turns.ts --isolated --json tmp/desktop-harness/chat-two-turns/report.json
bun scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-visible-lifecycle.ts --isolated --json tmp/desktop-harness/subagent-visible-lifecycle/report.json
bun scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-running-state.ts --isolated --json tmp/desktop-harness/subagent-running-state/report.json
bun scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-handoff-parent-wake.ts --isolated --json tmp/desktop-harness/subagent-handoff-parent-wake/report.json
bun scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-blocked-approval.ts --isolated --json tmp/desktop-harness/subagent-blocked-approval/report.json
bun scripts/desktop-harness.ts run tests/desktop-scenarios/goal-scoped-subagent-details.ts --isolated --json tmp/desktop-harness/goal-scoped-subagent-details/report.json
bun scripts/desktop-harness.ts run tests/desktop-scenarios/context-compaction-followup.ts --isolated --json tmp/desktop-harness/context-compaction-followup/report.json
bun run test:desktop:subagents
bun scripts/desktop-harness.ts run tests/desktop-scenarios/chat-two-turns.ts tests/desktop-scenarios/subagent-visible-lifecycle.ts tests/desktop-scenarios/subagent-running-state.ts tests/desktop-scenarios/subagent-handoff-parent-wake.ts tests/desktop-scenarios/subagent-blocked-approval.ts tests/desktop-scenarios/goal-scoped-subagent-details.ts tests/desktop-scenarios/context-compaction-followup.ts --isolated --json tmp/desktop-harness/desktop-scenarios/report.json
bun scripts/desktop-harness.ts run tests/desktop-scenarios/chat-two-turns.ts --packaged --app release/linux-unpacked/openpond --json tmp/desktop-harness/packaged-chat/report.json
bun scripts/desktop-harness-report.ts summarize tmp/desktop-harness/chat-two-turns/report.json tmp/desktop-harness/context-compaction-followup/report.json --json tmp/desktop-harness/release-proof/summary.json --markdown tmp/desktop-harness/release-proof/summary.md
bun run --cwd apps/cli cli harness desktop run tests/fixtures/desktop-harness/pass-scenario.ts --none --artifacts-dir tmp/desktop-harness/cli-wrapper --json tmp/desktop-harness/cli-wrapper/report.json
openpond harness desktop run tests/desktop-scenarios/chat-two-turns.ts --isolated --json tmp/desktop-harness/chat-two-turns/report.json
openpond harness desktop run tests/desktop-scenarios/chat-two-turns.ts --packaged --app release/linux-unpacked/openpond --json tmp/desktop-harness/packaged-chat/report.json
```
