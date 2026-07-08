# Subagent Lifecycle Working Notes

Status: active follow-up plan for subagent heartbeat, stale detection, and cleanup/archive lifecycle.  
Latest checkpoint: 2026-07-08. The core subagent stack is already implemented, including child sessions, run/message contracts, background execution, explicit child-to-parent mailbox handoffs, parent wake metadata, goal completion gating for unresolved required child runs, and baseline desktop harness coverage. The remaining work is the runtime-owned heartbeat/watcher, reliable last-activity exposure, stale/orphan handling, explicit cleanup/archive policy, richer derived buckets, and heartbeat-specific verification. `heartbeatIntervalSeconds` exists in preferences and the Settings UI, but no watcher consumes it yet.
Purpose: capture near-term direction for OpenPond subagents, especially in light of stronger agentic models such as GPT-5.6-class systems.

Related docs:

- [Subagent Orchestration Investigation](working-docs/agent-harness/2026-07-07-subagent-orchestration.md)
- [Verifiable Desktop Harness](working-docs/agent-harness/2026-07-08-verifiable-desktop-harness.md)

## Current read

OpenPond already has a substantial subagent implementation. The important primitives appear to exist:

- Typed subagent contracts, roles, reports, messages, and statuses.
- Parent/child linkage through goals and child sessions.
- Server tools for starting, joining, cancelling, status inspection, and messaging.
- Isolated execution through worktrees or sandbox forks.
- Structured child reports with findings, artifacts, patch refs, tests, blockers, and confidence.
- UI/runtime aggregation for active, blocked, completed, and graph-style task state.
- Explicit child-to-parent mailbox handoffs with bounded parent wake/enqueue behavior.
- Goal completion gating for unresolved required child runs.
- A `heartbeatIntervalSeconds` preference and Settings input, but no runtime heartbeat service yet.

The recommendation is not to add subagents as a new concept. The next improvement should be lifecycle hygiene and product polish around the subagent system that already exists.

## Current code anchors

- `packages/contracts/src/subagents.ts`: owns subagent preferences, role/run/report/message schemas, status enum, and `heartbeatIntervalSeconds`. `SubagentRun` still lacks an exposed `updatedAt`/last-activity field.
- `apps/server/src/store/store.ts`: persists `subagent_runs.updated_at` and orders `listSubagentRuns(...)` by that column. There is no dedicated active/stale query yet.
- `apps/server/src/runtime/turn-runner.ts`: owns `openpond_subagent_start/status/join/cancel/send_message`, explicit child-to-parent wake routing, goal completion gating, goal-resume `needs_resume` marking, child-turn finalization, and cancel-time git-worktree cleanup.
- `apps/web/src/lib/subagent-runtime.ts`: derives active, blocked, completed, required-open counts, evidence, blockers, usage, and task graph from `subagent.*` events. It does not yet expose separate required active/blocking/unresolved counts or archived/terminal buckets.
- `apps/web/src/components/goal/GoalDetailsView.tsx`: shows current subagent aggregate state and task graph in the Goal details panel.
- `tests/desktop-scenarios/README.md` and `package.json`: document the existing deterministic desktop subagent scenarios and `bun run test:desktop:subagents`. Heartbeat/stale/settings scenarios are still new work.

## Boundaries

- Do not rebuild the core subagent concept, contracts, tools, or child-session model.
- Do not use the heartbeat to make the parent model poll or wake for routine progress.
- Treat `needs review` and `archived` as UI/lifecycle buckets unless the contract intentionally adds them as persisted run statuses.
- Keep thread-scoped subagents working without a goal; goal state should add durable lifecycle context, not become the active orchestrator.

## Main direction

Make subagents feel like managed workers under a durable thread or goal scope, coordinated from a user-facing thread, not loose side chats.

The cleaner split is:

- The thread/session is the orchestrator: it talks to the user, plans, delegates, synthesizes, and decides when to ask for input.
- The goal is the durable work scope: it stores objective, lifecycle state, completion criteria, artifacts, child runs, and cleanup/archive policy.
- Subagents are bounded workers delegated by the thread within the goal scope.
- Child work should be visible as status, artifacts, blockers, and final handoffs.
- Goal lifecycle changes should drive child lifecycle cleanup, while the thread remains the interactive control surface.

This should mesh well with GPT-5.6-class models. Stronger models are likely to delegate more, run longer-horizon plans, and supervise complex work. That increases the value of explicit lifecycle, cleanup, auditability, and bounded worker contracts without turning the orchestrator itself into another hidden job object.

## Is the orchestrator a goal or a thread?

The orchestrator should probably be a thread/session, not the goal itself.

The goal should be the durable container and lifecycle authority. The thread should be the active coordinator inside that container.

The clean mental model is:

```text
Goal: durable work scope
  ├─ orchestrator thread/session: coordinator and synthesizer
  ├─ child subagent runs: bounded delegated workers
  ├─ artifacts: reports, diffs, screenshots, logs, test results
  └─ lifecycle policy: start, pause, resume, complete, stop, archive, cleanup
```

A parent thread can be the user-facing control surface, while the goal remains the stable owner for child runs even when sessions are hidden, compacted, resumed, or restarted.

## Why this fits GPT-5.6-style models

More capable agentic models do not remove the need for orchestration. They make orchestration more important.

Likely pressure from stronger models:

- More autonomous delegation.
- Longer-running tasks.
- More parallel subtasks.
- More tool use and workspace mutation.
- More need for review, rollback, and audit trails.
- More need to distinguish active work from stale or abandoned work.

OpenPond can lean into this by treating threads as orchestrators, goals as durable operating scopes, and subagents as typed, inspectable workers.


## Runtime heartbeat / watcher addition

Add a runtime-owned subagent heartbeat rather than making goals or parent model turns stay open.

The heartbeat should be a cheap watcher service, not a model tool and not a hidden orchestrator agent. It should only run while there are pending child runs to watch.

Recommended split:

```text
Thread/session = orchestrator behavior and user-facing synthesis
Goal = optional durable tracker/lifecycle container
Subagent = background worker/model session
Runtime heartbeat = deterministic watcher and wake router
```

### Default setting

Expose a Subagents setting named `heartbeatIntervalSeconds`, defaulting to `60`.

Suggested bounds:

- Minimum: `10` seconds
- Default: `60` seconds
- Maximum: `3600` seconds

This setting controls how often the runtime watcher checks active subagent runs. It should not imply that a parent model wakes every interval.

### When the heartbeat should run

Run only when at least one subagent is non-terminal, such as:

- `queued`
- `running`
- `blocked`
- `needs_resume`

Stop or idle the watcher when all known child runs are terminal:

- `completed`
- `failed`
- `cancelled`

### What the heartbeat checks

Prefer structured state over raw transcript scanning:

1. run status
2. last activity timestamp
3. pending child-to-parent messages
4. current/final report state
5. stale timeout conditions
6. workspace cleanup/archive eligibility

Raw last-message previews can be useful for UI, but should not be the main coordination protocol.

### Wake policy

The heartbeat may update UI/runtime state every interval, but should only queue a parent wake for meaningful events:

- a child asks the parent a question
- a required child blocks or fails
- all required children complete
- a stale/timeout threshold is reached
- the user explicitly requested follow-up

Do not wake the parent model for ordinary progress-only changes by default.

### Goal relationship

The heartbeat can be goal-aware, but should not be goal-owned.

If `parentGoalId` exists, the watcher should update goal-visible derived state such as required child completion, blockers, unresolved runs, and cleanup-needed markers. If no goal exists, the watcher should still work from `parentSessionId`.

This preserves the desired model:

```text
Subagent always has parentSessionId.
Subagent optionally has parentGoalId.
Heartbeat watches active child work.
Goal passively tracks durable lifecycle when present.
Thread resumes only when there is a decision or synthesis step.
```


## Phased implementation checklist

Use this as the working checklist for the heartbeat/lifecycle cleanup addition. Keep phases small enough that each can land independently.

### Phase 0: Product decision and naming

- [x] Keep goals; do not remake the goal abstraction. Done: current implementation already uses `parentGoalId` as optional durable scope.
- [x] Treat the parent thread/session as the orchestrator behavior. Done: parent sessions own model interaction and subagent tool calls.
- [x] Treat goals as passive durable lifecycle containers. Done: current goal handling gates completion/resume but does not run as a hidden orchestrator.
- [x] Treat heartbeat as runtime infrastructure, not a model tool. Done: this is a product decision; implementation still pending.
- [ ] Rename/clarify user-facing copy where subagents sound exclusively goal-owned.
- [ ] Decide whether UI should keep saying “heartbeat,” use “watcher,” or hide the term behind “background monitoring.” Current Settings copy says `Heartbeat seconds`.

### Phase 1: Settings surface and contracts

- [x] Add `heartbeatIntervalSeconds` to subagent preferences. Done: `SubagentPreferencesSchema` includes the setting.
- [x] Default to `60` seconds. Done: contract default is `60`.
- [x] Bound accepted values to `10–3600` seconds. Done: contract and numeric Settings input enforce the same range.
- [x] Add settings-page input for heartbeat seconds. Done: Subagents Settings shows `Heartbeat seconds`.
- [ ] Confirm persisted defaults are applied consistently for new users, existing users, and missing preference records.
- [ ] Add help text that this controls runtime checks, not parent model wake frequency.

### Phase 2: Runtime watcher foundation

This phase is not covered by the existing subagent queue or child-to-parent mailbox wake. It should introduce a runtime watcher that observes stored run state and emits/wakes only on policy-relevant lifecycle transitions.

- [ ] Add a runtime subagent watcher/heartbeat service.
- [ ] Start the watcher only when non-terminal child runs exist.
- [ ] Stop or idle the watcher when all watched child runs are terminal.
- [ ] Watch by `parentSessionId` first and `parentGoalId` when present.
- [ ] Prefer structured run state over transcript scanning.
- [ ] Record watcher ticks/events without waking the parent model by default.

### Phase 3: Status and stale detection

- [x] Store internal update timestamps for subagent rows. Done: SQLite stores `subagent_runs.updated_at` and orders list results by it.
- [x] Provide a generic run listing query. Done: `listSubagentRuns({ parentSessionId, parentGoalId, childSessionId, status, limit })` exists.
- [ ] Expose reliable `updatedAt`/last-activity data for subagent runs.
- [ ] Add a query like `listActiveSubagentRuns(...)` or a watcher-local helper that centralizes active status selection.
- [ ] Add a query like `listStaleSubagentRuns({ olderThanMs, statuses })`.
- [ ] Define stale as derived state first unless a persisted `stale` status becomes necessary.
- [ ] Mark stale optional runs as attention-needed or cancellable.
- [ ] Keep stale required runs visible as blockers.

### Phase 4: Wake routing policy

Existing explicit child-to-parent mailbox messages already queue or defer a bounded parent wake. The remaining rows below are for heartbeat-derived lifecycle events.

- [x] Queue parent wake for explicit child-to-parent mailbox handoffs. Done: `openpond_subagent_send_message` records parent wake delivery metadata and enqueues an idle parent follow-up.
- [x] Do not wake parent for ordinary routine lifecycle receipts by default. Done for current mailbox/lifecycle behavior; heartbeat must preserve this.
- [x] Make wake reasons explicit for mailbox handoffs. Done: delivery metadata records queued, deferred, already-queued, missing-parent, active-parent, and loop-limit reasons.
- [ ] Queue parent wake when a required child blocks or fails and the watcher observes that transition.
- [ ] Queue parent wake when all required children complete and watcher policy says synthesis is needed.
- [ ] Queue parent wake on stale/timeout threshold.
- [ ] Make watcher wake reasons explicit and visible in runtime events.
- [ ] Ensure parent model turns do not poll on a sleep loop.

### Phase 5: Goal-aware derived state

- [x] Gate goal completion on unresolved required children. Done: `openpond_goal_control complete` fails while required child runs are not completed.
- [x] Mark queued/running goal child runs as `needs_resume` when the parent goal resumes. Done: goal resume appends parent-visible `subagent.blocked` receipts for affected child runs.
- [x] Keep core thread-scoped subagents working when no goal exists. Done: `parentGoalId` is nullable and child runs always have `parentSessionId`.
- [ ] If `parentGoalId` exists, update watcher-derived goal-visible child state.
- [ ] Track required active, required blocking, and required unresolved counts separately.
- [ ] Make goal completion/stopping cleanup/archive policies apply to linked child runs.

### Phase 6: Cleanup and archive behavior

- [x] Clean git-worktree isolated workspace on explicit cancellation. Done: `openpond_subagent_cancel` interrupts the child and calls git-worktree cleanup unless `cleanupWorkspace` is false.
- [ ] Add or harden `cleanupSubagentRun(runId, reason, policy)`.
- [ ] Cleanup temporary worktrees/sandbox forks after safe terminal states.
- [ ] Retain reports, artifacts, patch refs, tests, and important messages.
- [ ] Archive completed child sessions after parent/goal completion.
- [ ] Allow retain-for-inspection for failures/cancellations.
- [ ] Emit cleanup started/completed/failed events.

### Phase 7: UI and observability

- [x] Show current active, blocked, completed, required-open, usage, evidence, checks, and task graph state. Done: current runtime projection and Goal details panel render these aggregates.
- [ ] Show heartbeat/watcher-derived status without implying the model is awake.
- [ ] Show active, blocking, unresolved, terminal, and archived buckets as lifecycle/UI buckets.
- [ ] Show latest meaningful update from structured state.
- [ ] Add “cleanup/archive” controls where appropriate.
- [ ] Add operational events for stale detected, wake queued, wake skipped, workspace retained, archived, and superseded.

### Phase 8: Verification

Use the verifiable desktop harness as the primary end-to-end product test path for this addition. See `docs/working-docs/agent-harness/2026-07-08-verifiable-desktop-harness.md` and the `openpond-desktop-harness` skill for scenario authoring rules.

- [x] Baseline desktop subagent scenario suite exists. Done: `bun run test:desktop:subagents` runs visible lifecycle, running state, child-to-parent handoff wake, blocked approval, and goal-scoped details scenarios.
- [ ] Unit test preference bounds/defaults.
- [ ] Unit test watcher start/stop behavior.
- [ ] Unit test wake policy cases.
- [ ] Unit test stale detection.
- [ ] Integration test: parent starts child, parent idles, child completes, watcher queues a policy-driven parent wake when appropriate.
- [ ] Integration test: no goal present, subagent still works under parent session.
- [ ] Integration test: goal present, derived required counts update.
- [ ] Integration test: goal stop cancels/cleans active child runs.
- [ ] Desktop harness scenario: heartbeat setting persists in Settings and makes clear it controls runtime checks, not parent model wake frequency.
- [ ] Desktop harness scenario: parent starts a child, parent turn idles, watcher observes completion, and parent wake is queued only for a meaningful event.
- [ ] Desktop harness scenario: child progress-only updates do not wake the parent model every heartbeat interval.
- [ ] Desktop harness scenario: thread-scoped subagent without a goal is still watched and reports status correctly.
- [ ] Desktop harness scenario: goal-scoped subagent updates goal-visible derived counts/status without making the goal an active orchestrator.
- [ ] Desktop harness scenario: stale/timeout child is surfaced as attention-needed or blocking according to required/optional policy.
- [ ] Run typecheck, focused unit tests, and relevant desktop harness scenarios.

## Cleanup priorities

### 1. Stale and orphaned run handling

Add explicit detection and handling for subagents that are no longer making progress.

Candidate stale statuses:

- `queued`
- `running`
- `blocked`
- `needs_resume`

Possible policy:

- Mark old inactive runs as stale or needs attention.
- Cancel stale optional runs after a threshold.
- Keep required stale runs visible as blockers.
- Avoid silently counting old failed/cancelled/blocked runs as normal open work.

### 2. Workspace cleanup

Make cleanup explicit and observable for isolated workspaces.

Cases to verify:

- Completed read-only subagent.
- Completed read/write subagent after report handoff.
- Cancelled queued subagent.
- Cancelled running subagent.
- Failed setup.
- Patch approval accepted, rejected, or conflicted.
- Parent goal stopped.
- Parent goal completed.

Suggested policy:

- Retain final report, artifact refs, patch refs, tests, and key messages.
- Clean temporary worktrees or sandbox forks by default after terminal states.
- Allow retain-for-inspection when cancellation or failure needs debugging.

### 3. Parent goal lifecycle coupling

Parent goal state should drive child run state.

Candidate rules:

- Parent stopped: cancel active child runs and cleanup temporary workspaces when safe.
- Parent completed: archive child sessions, retain final reports/artifacts, cleanup workspaces.
- Parent restarted: mark old child runs superseded or ask whether to reuse/retain them.
- Parent paused: pause or avoid starting new child runs.
- Parent resumed: resume eligible child runs or re-plan delegation.

### 4. Required-run semantics

Separate unresolved required work from active required work.

Useful buckets:

- `requiredActiveCount`: required runs in `queued`, `running`, or `needs_resume`.
- `requiredBlockingCount`: required runs in `blocked`, `failed`, or `cancelled`.
- `requiredUnresolvedCount`: required runs that did not complete successfully.

This avoids treating all non-completed required runs as the same kind of open work.

### 5. Archive and compact child outputs

Create a finalized child result view.

Keep:

- summary
- findings
- files changed or patch refs
- artifacts
- test results
- blockers or unresolved questions
- confidence/risk notes
- important parent/peer messages

Compact or hide:

- full child conversation by default
- low-value intermediate logs
- temporary workspace details after cleanup

### 6. Lifecycle events and debugging

Emit explicit events for lifecycle and cleanup transitions.

Useful events:

- subagent stale detected
- cleanup started
- cleanup completed
- cleanup failed
- workspace retained
- archived
- superseded
- parent stopped children
- patch applied/rejected/conflicted

This helps both UI and operational debugging.

## Product shape

The user should not experience subagents as many random chats. They should experience them as a thread-local, goal-aware worker panel.

Recommended UX:

- Compact worker list by default.
- Status chips from persisted run state: queued, running, blocked, needs resume, completed, failed, cancelled.
- UI/lifecycle buckets where useful: needs review, unresolved, terminal, archived.
- Required/optional marker.
- Latest meaningful update.
- Final report preview.
- Cleanup/archive controls.
- Expandable full details when needed.

## Near-term implementation slice

A practical first slice from the current code:

1. Add `updatedAt` or equivalent last-activity data to the subagent run contract/API projection.
2. Add active/stale run helpers such as `listActiveSubagentRuns(...)` and `listStaleSubagentRuns({ olderThanMs, statuses })`.
3. Add the watcher service that consumes `heartbeatIntervalSeconds`, starts only when active children exist, and emits explicit watcher events.
4. Add a cleanup/archive service such as `cleanupSubagentRun(runId, reason, policy)`.
5. Wire parent goal stop/complete to child cancellation/archive/cleanup.
6. Update UI aggregation to separate required active, required blocking, required unresolved, terminal, and archived buckets.
7. Add event coverage for cleanup/archive/stale/watcher-wake transitions.

## Desktop harness verification plan

Use the verifiable desktop harness as the acceptance test for subagent heartbeat/lifecycle additions, not just backend unit tests. The harness is the right proof layer because the feature spans settings, runtime events, parent/child sessions, optional goals, UI status, and parent wake behavior.

Reference: `docs/working-docs/agent-harness/2026-07-08-verifiable-desktop-harness.md`.

Recommended scenario additions under `tests/desktop-scenarios/`:

- `subagent-heartbeat-settings`: proves the Settings page exposes and persists `heartbeatIntervalSeconds` with bounds/default behavior and help text.
- `subagent-watch-completion-wake`: proves a child can finish while the parent is idle, the watcher records the meaningful event, and a parent wake is queued once when policy requires synthesis.
- `subagent-heartbeat-no-progress-wake`: proves ordinary progress-only updates do not resume the parent model on every heartbeat.
- `subagent-heartbeat-thread-scoped`: proves subagents with `parentSessionId` and no `parentGoalId` are still watched and visible.
- `subagent-heartbeat-goal-derived-state`: proves goal-scoped children update goal-visible required/active/blocking/completed counts while the goal remains a passive tracker.
- `subagent-heartbeat-stale`: proves stale or timed-out children are surfaced with the correct required/optional policy.

Existing `subagent-handoff-parent-wake.ts` already proves explicit mailbox handoff wake behavior. Do not duplicate that scenario for the watcher unless the watcher is observing a non-message lifecycle event.

Each scenario should record runtime events, bootstrap/session evidence, visible renderer assertions, and screenshot/JSON artifacts. Prefer scripted OpenPond models and event waits over sleeps or live provider calls.

## Validation

- Current evidence: 2026-07-08 doc alignment reviewed the current subagent contracts, store, runtime, UI projection, Goal details, existing desktop scenarios, and package scripts named in `Current code anchors`.
- Pending: all heartbeat/watcher/stale/cleanup implementation proof is still captured in Phase 8.
- Not run for this doc update: typecheck, unit tests, or desktop harness scenarios.

## Open questions

- Should `stale` be a new persisted status, or a derived condition from `status + updatedAt`?
- Should failed/cancelled required subagents block parent completion, require explicit acknowledgement, or both?
- Should parent goal completion always archive child sessions, or should active child sessions remain visible until acknowledged?
- Should read/write subagent workspaces be retained until patch approval is resolved?
- What is the default retention period for child messages, workspaces, and artifacts?
- Should stronger models be used mainly as parent supervisors, specialist workers, reviewers, or all three depending on budget?
- Should this top-level notes file stay at `docs/subagent-lifecycle-working-notes.md`, or be promoted under `docs/working-docs/agent-harness/` once implementation starts?

## Opinionated recommendation

Use threads as the orchestrator and goals as the durable parent scope. Keep subagents as first-class workers, but make their lifecycle boring and dependable.

The best GPT-5.6-era direction for OpenPond is not more visible chat sprawl. It is thread-led, goal-scoped orchestration with bounded workers, structured handoffs, automatic cleanup, and clear audit trails.
