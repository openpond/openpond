# Desktop Harness Scenarios

Scenario files in this directory are run by `pnpm exec tsx scripts/desktop-harness.ts run`.
They can also be run through the CLI wrapper with `openpond harness desktop run <scenario...>`.

Implemented scenarios:

- `model-training-starters.ts`: manual packaged draft/file/scope acceptance. Checks all four cards; sends the three enabled prompts through a real subscribed Codex agent only with `OPENPOND_STARTER_LIVE_ACCEPTANCE=1`. Weight-space remains disabled. Uses unreviewed local examples and a $0 compute limit; this does not prove accepted training preparation or execution. `OPENPOND_STARTER_MODEL` may select an entry verified in the installed agent catalog.

- `chat-two-turns.ts`: visible composer submission for a deterministic two-turn chat.
- `chat-multi-thread-stress.ts`: three concurrent delayed chat turns with switching, renderer reload, transcript isolation, persistence, timing, and screenshot proof.
- `chat-interrupt-recovery.ts`: visible Stop-response interruption after the first streamed chunk, followed by same-thread recovery and reload persistence proof.
- `chat-deepseek-live-stress.ts`: authenticated three-thread DeepSeek V4 Flash stress with model allowlisting, reload persistence, and a conservative usage-based cost ceiling.
- `subagent-heartbeat-settings.ts`: Subagents Settings background-check cadence copy, bounds, save, and reload readback proof.
- `subagent-heartbeat-no-progress-wake.ts`: long-running child proof that a routine heartbeat interval updates diagnostics without waking the parent model before submission.
- `subagent-heartbeat-thread-scoped.ts`: no-goal child proof that watcher submission wake and Subagents details work from `parentSessionId` alone.
- `subagent-heartbeat-stale.ts`: required/optional stale policy proof with required parent wake and optional attention-only receipt.
- `subagent-visible-lifecycle.ts`: deterministic parent/child subagent lifecycle with parent activity rows, child-session linkage, and screenshot proof.
- `subagent-running-state.ts`: delayed child run with visible sidebar/activity running state and submitted-for-review proof.
- `subagent-handoff-parent-wake.ts`: child-to-parent handoff receipt, deferred-until-submission parent wake metadata, and child linkage proof.
- `subagent-watch-submission-wake.ts`: submitted-for-review child packet, watcher-queued parent lifecycle wake, and compact child result proof.
- `subagent-review-revision-loop.ts`: parent/reviewer needs-revision decision, delivered child correction, revised child packet, and final accept proof.
- `subagent-bounded-worker-contract.ts`: copy-on-write coding child proof with structured worker brief, repeated search steering evidence, isolated write, validation command, submitted-for-review status, and patch handoff.
- `subagent-blocked-approval.ts`: write-capable child isolation blocker with parent blocked activity and linked child row proof.
- `context-compaction-followup.ts`: manual OpenPond summary compaction status row, persisted summary event, usage record, and post-compaction composer follow-up.
- `new-model-end-to-end.ts`: networkless Cross-System Operations proof from deterministic worlds and baseline traces through Miner/Creator, GRPO plus SFT-bootstrap lineage, local fixture training, frozen evaluation, constrained normal chat tools, and a real desktop/server restart.
- `subagent-suite.ts`: the deterministic desktop regression suite for subagent additions.

Artifact convention:

- Default run artifacts: `tmp/desktop-harness/<iso-timestamp>/`.
- Per-scenario artifacts: `tmp/desktop-harness/<iso-timestamp>/<scenario-name>/`.
- Explicit runs should prefer `--artifacts-dir tmp/desktop-harness/<purpose>` and `--json tmp/desktop-harness/<purpose>/report.json`.
- Packaged runs require a prebuilt desktop app and should pass `--packaged --app <path>` or rely on standard `release/` candidates.

Use server APIs for setup-heavy state. Use real renderer actions only when the scenario is proving visible UX behavior.

`weight-space-live-prepare.ts` is a manual connected acceptance using an existing
Codex subscription and the selected Desktop account. It sends one preparation-only
request from a new empty temporary directory, uses the installed CLI contract,
retains the real capability receipt, and reopens the transcript. An unavailable
runtime proves the admission boundary; it does not prove successful preparation
or attachment. When the exact runtime is ready, the scenario also requires an
accepted prepared execution and its original attachment after reload. It never
authorizes GPU execution, scoring, serving or schedules and is not routine CI.
Set `OPENPOND_WSP_ACCEPTANCE_SESSION_ID` to inspect an existing acceptance turn
without sending another prompt. Use `OPENPOND_WSP_ACCEPTANCE_TURN_ID` to select
the exact original turn in a chat with multiple preparations. Recovery reads
the chat's paginated event history, including turns outside the recent global
event window; a missing retained completion fails without another prompt.

For a protected preparation handoff, provide `OPENPOND_WSP_ACCEPTANCE_PREPARE_FILE`
and `OPENPOND_WSP_ACCEPTANCE_PREPARE_SHA256` together. The scenario copies the
reviewed input unchanged into the new chat directory, requires matching ready
capability, verifies the accepted receipt against that input, and checks its
attachment after reopening. The Desktop agent prepares on behalf of the declared
editing teacher; the teacher identity remains unchanged. Confirm the operation
has never been submitted and arrange the teacher handoff before running. Complete
handoff before the returned plan expires; expiry does not authorize another
preparation or operation. Confirm custody of the running renderer before using
its debug connection.

When another acceptance owns the renderer, `OPENPOND_WSP_ACCEPTANCE_SERVER_ONLY=1`
issues the original prompt through the running Desktop server in its own chat.
It verifies the real CLI receipt without changing the screen, and writes
`original-prepare-receipt.json` for immediate teacher handoff. Attachment and
rendered reopening remain unproved in this mode. After the renderer is free, rerun
with the recorded session ID and the original reviewed input, without server-only
mode, to prove reopening without another prompt or Prepare. The same attachment
may then correctly show the execution's later phase.
Use `OPENPOND_WSP_ACCEPTANCE_CONTINUE_SESSION_ID` instead of the resume variable
to submit a new reviewed preparation in an existing server-only chat. Each turn
retains its own identity and receipt; set `OPENPOND_WSP_ACCEPTANCE_TURN_ID` when
later inspecting a particular completed turn in a chat with multiple turns.

Useful commands:

```bash
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/chat-two-turns.ts --isolated --json tmp/desktop-harness/chat-two-turns/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/chat-multi-thread-stress.ts --isolated --json tmp/desktop-harness/chat-multi-thread-stress/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/chat-interrupt-recovery.ts --isolated --json tmp/desktop-harness/chat-interrupt-recovery/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/chat-deepseek-live-stress.ts --attach --server http://127.0.0.1:17877 --token-file /path/to/token --devtools-port 9239 --json tmp/desktop-harness/chat-deepseek-live-stress/report.json
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
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/context-compaction-followup.ts --isolated --json tmp/desktop-harness/context-compaction-followup/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/new-model-end-to-end.ts --isolated --timeout-ms 300000 --json tmp/desktop-harness/new-model-end-to-end/report.json
pnpm test:desktop:subagents
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/chat-two-turns.ts tests/desktop-scenarios/subagent-heartbeat-settings.ts tests/desktop-scenarios/subagent-heartbeat-no-progress-wake.ts tests/desktop-scenarios/subagent-heartbeat-thread-scoped.ts tests/desktop-scenarios/subagent-heartbeat-stale.ts tests/desktop-scenarios/subagent-visible-lifecycle.ts tests/desktop-scenarios/subagent-running-state.ts tests/desktop-scenarios/subagent-handoff-parent-wake.ts tests/desktop-scenarios/subagent-watch-submission-wake.ts tests/desktop-scenarios/subagent-review-revision-loop.ts tests/desktop-scenarios/subagent-bounded-worker-contract.ts tests/desktop-scenarios/subagent-blocked-approval.ts tests/desktop-scenarios/context-compaction-followup.ts --isolated --timeout-ms 300000 --json tmp/desktop-harness/desktop-scenarios/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/chat-two-turns.ts --packaged --app release/linux-unpacked/openpond-desktop --json tmp/desktop-harness/packaged-chat/report.json
pnpm exec tsx scripts/desktop-harness-report.ts summarize tmp/desktop-harness/chat-two-turns/report.json tmp/desktop-harness/context-compaction-followup/report.json --json tmp/desktop-harness/release-proof/summary.json --markdown tmp/desktop-harness/release-proof/summary.md
pnpm --dir apps/cli cli harness desktop run tests/fixtures/desktop-harness/pass-scenario.ts --none --artifacts-dir tmp/desktop-harness/cli-wrapper --json tmp/desktop-harness/cli-wrapper/report.json
openpond harness desktop run tests/desktop-scenarios/chat-two-turns.ts --isolated --json tmp/desktop-harness/chat-two-turns/report.json
openpond harness desktop run tests/desktop-scenarios/chat-two-turns.ts --packaged --app release/linux-unpacked/openpond-desktop --json tmp/desktop-harness/packaged-chat/report.json
```
