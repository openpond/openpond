# Subagent Lifecycle Working Notes

Status: implemented and verified for the focused subagent bounded-worker, submission/review, heartbeat, stale-detection, cleanup/archive lifecycle slice.
Latest checkpoint: 2026-07-09. Phase 9 desktop lifecycle coverage is complete for the current slice: Settings persistence/copy, progress-only no-wake behavior, thread-scoped watching without a goal, stale required/optional surfacing, watcher-submission parent wake, parent review/revision/acceptance loop, bounded copy-on-write coding-worker handoff, goal-scoped derived state, and the existing visible/running/handoff/blocked scenarios all pass in `bun run test:desktop:subagents` as a 12-scenario suite. Fresh completion-audit proof passed `bun run build:contracts`, `bun run typecheck`, `git diff --check`, the 185-test focused lifecycle unit suite, and the desktop suite report generated at `2026-07-09T07:33:32.504Z`. The proof exposed and fixed two root lifecycle bugs: watcher ticks were originally starved behind long-running child execution on the shared `subagent` worker queue, and the bounded-worker scripted proof initially reused the same native `exec_command` tool-call id for setup and validation, causing the runtime progress ledger to dedupe the validation event. The server now runs watcher ticks on a dedicated `subagent-lifecycle` queue, and scripted native tool calls use stable argument-derived ids. This pass also hardened patch-approval lifecycle behavior: accepted patches apply into the parent checkout and then clean the child worktree; declined and cancelled patch approvals keep the child worktree readable, record `applyResult.status`, and emit `subagent.workspace_retained`; cancelled approvals now emit `subagent.cancelled` instead of a revision receipt; apply conflicts keep the approval pending and preserve both parent and child workspace state for retry. Retained child workspaces now carry explicit 7-day retain-for-inspection metadata with an expiry, Goal details surfaces that expiry in compact child results, and the lifecycle watcher enforces `cleanupAfterExpiry` by calling the runner's `retention_expired` cleanup path even when no child runs are active. Retained workspaces now also emit a deduped `subagent.workspace_retention_expiring` operational warning 24 hours before automatic cleanup without waking the parent model by default. Child messages and non-workspace artifact refs now have an explicit default evidence-retention policy: retain with the parent thread/goal indefinitely, with no expiry cleanup. Packet quality is now structured on review state: missing final summary is an incomplete packet blocker, while missing requested validation or unvalidated workspace changes produce a weak submitted packet with low confidence and human review recommended. Packet quality also carries derived evidence counts for final-summary presence/length, requested validation, validation attempts and failures, tests run, changed files, patch/diff refs, artifacts, findings, blockers, and unvalidated workspace changes; watcher prompts and compact Goal details results now show those facts instead of forcing reviewers to infer them from prose. Blocked, failed, or cancelled required subagents now still block goal completion until the parent explicitly dismisses them through review; dismissal resolves goal gating without counting the child as accepted. Phase 2.6 is now implemented: independent-review recommendations are structured per-run review metadata derived from packet facts and projected into watcher prompts plus compact Goal details results, routing reasons are now a closed contract enum rather than arbitrary durable strings, and broad-edit/high-risk routing thresholds are role-configurable through typed review-routing policy defaults. Repeated-exploration steering strictness is also role-configurable through typed thresholds for repeated search, read, and command patterns while preserving the existing default of steering on the second repeat. The design treats the child model's "done" decision as authority to stop and submit a review packet, not authority to accept its own work; runtime determinism is limited to packet capture, status transitions, packet-quality facts, factual evidence, and advisory review-routing recommendations.
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
- Run statuses now distinguish child-submitted work from parent/reviewer-accepted work with `submitted_for_review`, `needs_revision`, `needs_user_input`, `accepted`, `failed_with_artifacts`, and restart-dismissed `superseded`; `review.status = "dismissed"` explicitly acknowledges blocked/failed/cancelled work without counting it as accepted. Legacy `completed` still parses for existing records, but new lifecycle work should use the first-class submitted/accepted semantics rather than adding a compatibility slice.
- UI/runtime aggregation for active, blocked, completed, and graph-style task state.
- Explicit child-to-parent mailbox handoffs with bounded parent wake/enqueue behavior.
- Goal completion gating for unresolved required child runs.
- Subagents are already goal-aware rather than goal-backed: each run has a required `parentSessionId`, while `parentGoalId` is nullable and only set when the parent thread has an active goal.
- A `heartbeatIntervalSeconds` preference and Settings input surfaced as background checks, now consumed by the first runtime watcher foundation.

The recommendation is not to add subagents as a new concept. The next improvement should be bounded worker execution plus lifecycle hygiene and product polish around the subagent system that already exists.

## Decision snapshot

- Subagents should be goal-aware, not goal-backed. Every child run belongs to a parent session; `parentGoalId` is optional scope metadata when a goal exists.
- The active orchestrator is the parent thread/session, not the goal object and not a hidden subagent-specific goal.
- Goals remain durable lifecycle containers: objective, completion policy, child-run counts, artifacts, cleanup/archive state, and restart/stop/complete policy.
- Not every subagent call should create or require a goal. Thread-scoped subagents are a first-class path.
- A child model can decide "I am done" on its own by stopping and producing a final report. OpenPond records that as `submitted_for_review`.
- That child "done" decision is a model judgment made by the child against its worker brief. It is not deterministic semantic proof and does not require a separate judge before the child can stop.
- The runtime should not require a pre-review judge before letting the child stop. A structurally valid final report is enough to create the submission boundary.
- Do not run a child self-judge on every tool turn. The child loop should continue normally until the child model emits a final report, blocker, or explicit handoff; review starts at that boundary.
- The child does not self-accept required work. Parent/reviewer judgment changes a submitted packet to accepted, needs revision, needs user input, failed with artifacts, or dismissed when blocked/failed/cancelled work is intentionally acknowledged without acceptance.
- Runtime evidence should be derived as much as possible from facts the runner already observes: tool calls, files read, diffs, validation exit codes, artifacts, blockers, provider errors, timestamps, and final reports.
- Derived runtime evidence is not a semantic truth engine. It makes the review packet auditable; it does not deterministically prove arbitrary task success.
- Deterministic gates should be structural packet gates, not arbitrary-task-success gates. They can require a report, status transition, evidence refs, validation attempts, blocker text, and failure metadata; they should not decide that an open-ended task is correct.
- A reviewer model is optional and boundary-based. It is useful for high-risk diffs, broad edits, ambiguous validation, low confidence, or explicit independent-review requests, not for every child tool turn.
- Independent-review routing should become structured subagent review metadata, not goal state. Goals can project the count/status, but the source of truth belongs to the child run's review packet.
- Keep copy-on-write as the default for background coding subagents as long as dependency hydration, patch handoff, and cleanup/archive remain reliable.
- Treat delegation appetite as parent-thread policy, not goal or child-run state. Use `manual`, `balanced`, and `proactive` modes with a global default and nullable per-session override.
- Inject the resolved delegation mode only into the parent system context. Child workers receive their bounded worker context, not the parent's delegation policy.
- Use stronger models where the marginal value is highest: parent supervision/synthesis and boundary review first; specialist worker roles can opt into stronger models through role `modelRef` when the task risk or budget justifies it. Do not force every subagent onto the strongest model by default.

## Failure modes this spec must prevent

The failed long-running chat showed that the problem is not solved by simply lowering `maxTurns`. Budgets are useful fuses, but the root fixes are lifecycle and evidence fixes:

- Watcher progress must not be starved behind long-running child execution. Lifecycle monitoring needs its own queue or equivalent scheduling isolation.
- Runtime progress evidence must dedupe by real invocation identity, not by broad tool name, or setup and validation calls can collapse into one misleading ledger event.
- Child `done` must not mean accepted. A child can stop and submit, but required work remains unresolved until the parent or reviewer accepts or explicitly dismisses it.
- A goal must not become a hidden orchestrator. It can scope, count, gate, clean up, and archive child work, but the active coordinator remains the parent thread/session.
- Copy-on-write should remain the default for background coding workers, because it protects the parent checkout and preserves failed work for review. That default depends on reliable dependency hydration, patch handoff, retained-workspace metadata, and expiry cleanup.
- Repeated exploration should be steered from observed runtime facts and role policy, not from a blanket turn cap. The child should be nudged toward edit, validate, report, or blocker when it repeats low-value search/read/command patterns.

Keep three completion claims separate:

| Claim | Owner | Meaning |
| --- | --- | --- |
| `submitted_for_review` | Child model | The child decided it has enough to submit from its worker brief. |
| `packetQuality` and `reviewerRouting*` | Runtime | The submission has structured facts, evidence, risks, and advisory review routing. |
| `accepted` or `dismissed` | Parent/reviewer | The work is accepted for synthesis/goal completion, or a blocked/failed/cancelled child is intentionally acknowledged without acceptance. |

## Current code anchors

- `packages/contracts/src/subagents.ts`: owns subagent preferences, role/run/report/message schemas, status enum, `heartbeatIntervalSeconds`, `SubagentWorkerBriefSchema`, `SubagentProgressSchema`, `SubagentExplorationSteeringPolicySchema`, `SubagentEvidenceRetentionPolicySchema` with default `retain_with_parent` indefinite message/artifact retention, `SubagentReviewPacketQualityEvidenceSchema`, `SubagentReviewPacketQualitySchema`, `SubagentReviewRoutingPolicySchema` plus default high-risk path patterns, `SubagentReviewRoutingReasonSchema`, `SubagentReviewRoutingEvidenceSchema`, `SubagentReviewStateSchema` including dismissed review decisions plus `independentReviewRecommended`, typed `reviewerRoutingReasons`, and `reviewerRoutingEvidence`, `SubagentLifecycleActionRequestSchema`, typed subagent runtime events including `subagent.workspace_retained`, `subagent.workspace_retention_expiring`, `subagent.archived`, `subagent.superseded`, and `subagent.dismissed`, and exposed `SubagentRun.updatedAt`.
- `apps/server/src/openpond/goal-control.ts`: owns OpenPond goal-control records and the optional `OpenPondGoalSubagentState` snapshot shape used for durable goal-visible child counts, cleanup state, and archive state.
- `apps/server/src/store/store.ts`: persists `subagent_runs.updated_at`, hydrates it as `SubagentRun.updatedAt`, orders `listSubagentRuns(...)` by that column, provides `listActiveSubagentRuns(...)`, `listStaleSubagentRuns(...)`, plus `listSubagentRunScopes(...)` for scope-first watcher passes, and records retained-workspace expiry warning metadata without bumping `updated_at`.
- `apps/server/src/runtime/background-worker-queue.ts`: keeps child execution on `subagent` while watcher ticks run on the separate `subagent-lifecycle` queue, preventing long-running children from starving lifecycle monitoring.
- `apps/server/src/openpond/capability-tool-registry.ts`: defines `openpond_subagent_start` with `roleId`, `objective`, optional `context`, optional structured `workerBrief`, and optional `required`; also exposes `openpond_subagent_review` for explicit parent/reviewer accept, needs-revision, needs-user-input, and blocked/failed/cancelled dismiss decisions.
- `apps/server/src/openpond/shell-command.ts`, `apps/server/src/openpond/command-access.ts`, and `apps/server/src/openpond/sandboxes.ts`: normalize local and sandbox shell execution with Bash `pipefail` semantics so piped validation commands preserve the failing stage exit status.
- `apps/server/src/runtime/turn-runner.ts`: owns `openpond_subagent_start/status/join/cancel/send_message`, explicit child-to-parent wake routing, goal completion gating, goal-resume `needs_resume` marking, goal stop/complete child lifecycle coupling, goal-restart `superseded` marking for prior linked children, manual `runSubagentLifecycleAction(...)` cleanup/archive control, `cleanupExpiredRetainedSubagentWorkspace(...)` for watcher-enforced retention expiry, child-session archive on safe goal terminal paths, post-lifecycle `thread_goal` diagnostics with derived `goal.subagents` counts, child-turn finalization, packet-quality assessment with structured evidence counts, typed role-policy-aware review-routing recommendation derivation, explicit dismissal of blocked/failed/cancelled children, local copy-on-write worktree dependency links for ignored `node_modules` artifacts, accepted/cancelled/manual/retention-expired git-worktree cleanup, explicit workspace-retained cleanup receipts with 7-day retention metadata, explicit evidence-retention metadata on cleanup/archive records, patch-approval accept/decline/cancel/conflict handling including retained-workspace metadata on declined/cancelled approvals, sandbox-fork delete cleanup via `cleanupSandboxForSubagent`, durable patch handoff artifacts, provider-failure `failureHandoff` metadata, and the hosted child tool loop that now injects repeated-exploration steering after tool results using role-configured search/read/command thresholds. `startSubagentFromModelTool(...)` always uses the parent session as the orchestrator via `parentSessionId: context.session.id`, only attaches `parentGoalId` from `activeThreadGoalId(...)` when an active goal exists, picks child models in role override -> subagent default -> parent model -> app default order, constructs a typed worker brief for every launch, marks child final reports as `submitted_for_review`, derives child progress ledger state from runtime tool events, and recommends independent review from packet quality, low confidence, validation failure/missing validation, role-configured broad edit surface, role-configured high-risk paths, provider failure after changes, or explicit independent-review request.
- `apps/server/src/runtime/subagent-lifecycle-watcher.ts`: runs heartbeat checks from structured subagent run state, discovers parent/goal scopes before loading active/stale/terminal run sets, records diagnostic tick evidence, counts review/stale buckets, emits deduped typed stale-attention receipts, auto-cancels optional stale `queued`/`running`/`blocked`/`needs_resume` runs after the grace threshold with best-effort child-turn interrupt, auto-cancels active orphaned child runs when the parent session is missing or archived, scans retained-workspace metadata for 24-hour pre-cleanup warning and expired `cleanupAfterExpiry` records, schedules future ticks for the next retained-workspace warning or expiry, replaces later timers when earlier retained-workspace attention appears, emits deduped `subagent.workspace_retention_expiring` warnings without parent wake, invokes runner-owned cleanup for expired retained workspaces, dynamically arms/disarms the interval from subagent run state changes, follows the `heartbeatIntervalSeconds` scheduling setting, and queues deduped parent follow-up turns only for required lifecycle attention states. Boundary wake prompts now include the original objective, worker brief, final report, runtime evidence, validation attempts, patch/artifact refs, blockers, packet-quality status/evidence, structured reviewer-routing recommendation/evidence, and explicit accept/revise/user-input/independent-review/retry-or-cancel options.
- `apps/server/src/openpond/scripted-chat-provider.ts`: includes deterministic scripted subagent lifecycle models, including `openpond-scripted-subagent-watch-submission`, `openpond-scripted-subagent-progress-only`, `openpond-scripted-subagent-stale`, `openpond-scripted-subagent-review-revision`, and `openpond-scripted-subagent-bounded-worker`, so desktop scenarios can prove watcher-submission, no-wake heartbeat, stale policy, parent review/revision/acceptance behavior, bounded copy-on-write worker execution, and validation packet evidence without live provider variance. Scripted native tool calls use stable argument-derived ids so repeated native calls with different arguments are not collapsed by runtime progress dedupe.
- `apps/server/src/openpond/native-tool-calls.ts`: turns native tool results into provider `tool` messages. Runtime steering now lives in `turn-runner.ts` child-loop policy rather than protocol formatting.
- `apps/web/src/lib/goal-runtime.ts`: parses optional `goal.subagents` snapshots from `thread_goal` diagnostics so durable goal runtime state can retain derived child counts even when full subagent event projection is not the only reader.
- `apps/web/src/lib/subagent-runtime.ts`: derives active, submitted, needs-revision, needs-user-input, accepted/completed, failed-with-artifacts, blocked, unresolved, terminal, archived, superseded-as-resolved, and required lifecycle/review counts from `subagent.*` events; it also projects watcher background-check state, latest meaningful child update, compact `finalResults` summaries from structured report/progress/message/packet-quality status and evidence/reviewer-routing fields, and retained-workspace expiry metadata for compact result display.
- `apps/server/src/api/routes/session-routes.ts` and `apps/web/src/api.ts`: expose `POST /v1/subagents/:runId/lifecycle` for explicit cleanup/archive lifecycle controls.
- `apps/web/src/components/goal/GoalDetailsView.tsx`: shows current subagent aggregate state, watcher background-check status, latest meaningful update, lifecycle/review/required buckets, compact child final results including packet-quality status/evidence, independent-review recommendation, and retained-workspace expiry, cleanup/archive controls for eligible terminal child runs, usage/evidence/checks, and task graph in the Goal details panel.
- `apps/web/src/components/sidebar/SidebarRows.tsx`: includes active, blocked, unresolved, terminal, and archived subagent counts in sidebar popover details.
- `scripts/desktop-harness/events.ts` and `scripts/desktop-harness/types.ts`: expose `waitForSubagentSubmitted(...)` so desktop tests wait for `subagent.submitted` and `submitted_for_review` instead of the old child-completed receipt.
- `tests/desktop-scenarios/subagent-heartbeat-settings.ts`, `tests/desktop-scenarios/subagent-heartbeat-no-progress-wake.ts`, `tests/desktop-scenarios/subagent-heartbeat-thread-scoped.ts`, `tests/desktop-scenarios/subagent-heartbeat-stale.ts`, `tests/desktop-scenarios/subagent-watch-submission-wake.ts`, `tests/desktop-scenarios/subagent-review-revision-loop.ts`, `tests/desktop-scenarios/subagent-bounded-worker-contract.ts`, `tests/desktop-scenarios/goal-scoped-subagent-details.ts`, `tests/desktop-scenarios/README.md`, and `package.json`: document and run deterministic desktop subagent scenarios for heartbeat Settings persistence/copy, routine no-wake ticks, thread-scoped watching, stale required/optional policy, watcher-submission parent wake behavior, parent review/revision/acceptance behavior, bounded copy-on-write worker validation/handoff, and goal-visible submitted-state behavior through `bun run test:desktop:subagents`.

## Boundaries

- Do not rebuild the core subagent concept, contracts, tools, or child-session model.
- Do not add new compatibility/fallback branches for the lifecycle redesign unless they are explicitly needed for already-persisted records.
- Do not use the heartbeat to make the parent model poll or wake for routine progress.
- Do not merge active worker execution control into the goal object. Goals should own durable scope and completion policy; subagent runs should own child execution briefs, phase state, progress ledgers, validation evidence, and failure handoff state.
- Do not make a goal mandatory for subagent execution. Thread-scoped subagents should keep working from `parentSessionId` alone.
- Do not rely on blind `maxTurns` or `maxTokens` as the primary fix for inefficient child execution. Keep budgets as fuses behind structured progress control.
- Do not treat a child model saying "done" as deterministic semantic completion. Treat it as a deterministic submission event that creates a review packet.
- Do not require a separate judge before a child can stop. The child model owns stop-and-submit; review happens after the runtime has a packet.
- Do not make runtime evidence checks a separate truth engine. Runtime evidence is review input; the parent/reviewer decides acceptance or revision.
- Do not run a judge on every child tool turn by default. A parent or reviewer model can judge boundary packets, but routine tool-loop progress should stay runtime-derived and cheap.
- Do not store child execution or review-routing authority primarily on the goal. Goals can expose derived lifecycle summaries, but child runs own briefs, packets, routing facts, review decisions, artifacts, and cleanup state.
- Treat `needs review` and `archived` as UI/lifecycle buckets unless the contract intentionally adds them as persisted run statuses.
- Keep thread-scoped subagents working without a goal; goal state should add durable lifecycle context, not become the active orchestrator.

## Main direction

Make subagents feel like managed workers under a durable thread or goal scope, coordinated from a user-facing thread, not loose side chats.

The cleaner split is:

- The thread/session is the orchestrator: it talks to the user, plans, delegates, synthesizes, and decides when to ask for input.
- The goal is the durable work scope: it stores objective, lifecycle state, completion criteria, artifacts, child runs, and cleanup/archive policy.
- Subagents are bounded workers delegated by the thread within the optional goal scope.
- Subagent launches should carry structured worker briefs, not only freeform objectives. The parent thread can derive the brief from the user request and active goal context, but the executable child contract should live with the child run.
- A child model can autonomously decide it is done and submit its result. OpenPond should record that as submitted-for-review, not as parent acceptance.
- The child owns the stop-and-submit decision. The parent/reviewer owns the accept/revise/user-input decision.
- The parent thread, or a separate reviewer model when useful, decides whether submitted child work is accepted, needs revision, or needs user input.
- Child work should be visible as status, artifacts, blockers, and final handoffs.
- Goal lifecycle changes should drive child lifecycle cleanup, while the thread remains the interactive control surface.

This should mesh well with GPT-5.6-class models. Stronger models are likely to delegate more, run longer-horizon plans, and supervise complex work. That increases the value of explicit lifecycle, cleanup, auditability, and bounded worker contracts without turning the orchestrator itself into another hidden job object.

## Is the orchestrator a goal or a thread?

The orchestrator should probably be a thread/session, not the goal itself.

The goal should be the durable container and lifecycle authority. The thread should be the active coordinator inside that container.

Current code already mostly follows this model. Subagent start runs from the parent session context, stores `parentSessionId` on the child session and `SubagentRun`, and stores `parentGoalId` only when `activeThreadGoalId(...)` finds an active goal for that parent session. Goal continuation also resumes work by injecting goal context into the same session/model turn; it does not create a separate goal-owned orchestrator.

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

## Bounded worker execution contract

The current `openpond_subagent_start` shape is too freeform for background coding work. It gives the child an objective and context pack, then the hosted tool loop repeatedly feeds tool results back to the model. That is enough for simple delegation, but it does not give the runtime a way to tell whether the child is still making progress, repeating exploration, validating correctly, or has produced a reviewable submission.

Add a structured child execution brief to the subagent launch/run contract. The parent thread should populate it when starting a child, and the server should construct a valid brief for every subagent launch before persisting the run. Do not treat this as a compatibility shim or long-lived metadata blob; OpenPond is a WIP, so update the known launch paths to produce first-class typed worker state.

First-class worker brief fields:

- `plan`: short ordered steps the child is expected to follow.
- `targetFiles`: known or suspected files/directories to inspect first.
- `acceptanceCriteria`: observable conditions for a complete result.
- `validationCommands`: commands the child should run or explain why it cannot run.
- `stopConditions`: conditions that should force report/blocker instead of more exploration.

The runtime should store a typed child progress ledger alongside the run:

- current phase: `orient`, `edit`, `validate`, `report`, or `submitted`
- unique files/resources inspected
- repeated searches/reads and repeated command patterns
- files changed or patch/diff refs created
- validation commands attempted with true exit status
- latest meaningful activity and current blocker

The progress ledger should be runtime-derived wherever possible. The model can explain what it intends to do next, but the runner should derive phase/progress from observed facts: tool calls, files/resources read, repeated query strings, git diff state, validation command invocations, exit codes, child messages, and final reports. This keeps UI, stale detection, and steering reliable when a model overstates progress, loops, or misreads a failed command. The ledger is not a deterministic semantic judge; it is the factual review packet that makes parent/reviewer judgment auditable.

Tool/result identity is part of that evidence contract. The runner should dedupe by a per-invocation identity, not by tool name alone; scripted and hosted providers must emit stable unique tool-call ids when they call the same native tool with different arguments. Otherwise two commands such as setup and validation can collapse into one ledger event and make a review packet falsely look unvalidated.

This does not make the goal the active orchestrator. The goal can store high-level objective and completion criteria, but the child execution brief belongs to the subagent run because thread-scoped subagents must work without a goal and because each delegated worker may need a different plan.

## Child submission and review model

The child model should be allowed to decide when it is done. That decision happens through the normal child model loop: the child stops work and emits a final report or equivalent submission. OpenPond should treat that as a deterministic event because it can atomically record `submitted_for_review` and attach a packet. It should not treat it as deterministic proof that the task is correct.

Important detail: the child decides "done" via the model, not via a runtime semantic proof. The deterministic part is the runtime boundary after that model decision: stop the child loop, record the submitted status, capture a packet, and route it for review. If the packet is structurally incomplete, the runtime should ask for a structured report, mark a blocker, or surface packet-quality failure; it should not silently promote the work to accepted.

Implementation rule: do not put a semantic judge in front of child stop-and-submit. Once the child model emits a final report or explicit completion handoff, the runner should finalize the child turn as `submitted_for_review` when the packet has the minimum required structure. Packet-quality checks can label the packet `weak` or `incomplete`, attach missing-evidence issues, and route review more urgently; they should not become a hidden "did the arbitrary task succeed" oracle.

If the packet fails minimum structure, prefer one bounded repair path: ask the child for the missing structured report or record an incomplete packet/blocker. Do not keep the child in an open-ended continuation loop merely because the model has not produced perfect evidence. The parent/reviewer can send a concrete `needs_revision` message after submission if the packet is reviewable but not acceptable.

The review pass is post-submission, not each-turn child self-evaluation. If the parent or an optional reviewer finds a problem, it should send a targeted `needs_revision` correction or ask for user input; the child can then resume from that concrete correction instead of spinning in pre-submit self-judgment.

The important split is:

- Child model decision: "I have done enough useful work to submit."
- Runtime decision: "A review packet exists and has factual evidence attached."
- Parent/reviewer decision: "This packet is accepted, needs revision, needs user input, or failed with recoverable artifacts."

Authority split:

| Layer | Owns | Does not own |
| --- | --- | --- |
| Child model | Deciding to stop and submit a final packet from its worker brief. | Accepting required work or satisfying goal completion. |
| Runtime | Recording the submission boundary, packet structure, factual evidence, validation attempts, changed-file refs, and routing facts. | Proving arbitrary task success. |
| Parent thread | User-facing planning, delegation, synthesis, and normal packet review. | Being a hidden goal-owned worker. |
| Optional reviewer model | Independent boundary review when risk, breadth, validation ambiguity, low confidence, or user request warrants it. | Running on every child turn or blocking child stop-and-submit. |
| Goal | Durable scope, completion policy, derived child counts, artifacts, cleanup/archive policy. | Owning the active subagent loop or replacing per-run review state. |

Treat child completion as a review boundary:

```text
parent gives brief
child works
child decides: "I am done"
runtime records: submitted_for_review + review packet
parent/reviewer evaluates the packet against the original brief
parent accepts, asks the child to revise, starts a reviewer, or asks the user
```

This means "done" has two layers:

- `submitted_for_review`: model-owned and child-initiated.
- `accepted`: parent/reviewer-owned and required before synthesis or required-goal completion.

The review packet should contain:

- original objective and structured worker brief
- child final report
- changed files and diff/patch refs when files changed
- artifacts, screenshots, logs, or research refs
- validation commands attempted, true exit status, and short output summary
- child blocker/risk claims
- runtime-observed provider/tool errors after meaningful work
- progress ledger summary, including repeated-exploration steering if it happened

The parent or reviewer should review at boundaries, not every tool turn:

- child submits a final report
- child reports blocked
- runtime detects repeated no-progress behavior
- validation fails or cannot run
- provider/tool failure occurs after edits or artifact creation
- high-risk or broad diff needs a second pass before applying

The first implementation should not try to deterministically prove arbitrary task success. The deterministic runtime transition is `child submitted a review packet`; semantic acceptance is a parent/reviewer decision using the original brief, runtime evidence, validation output, diff/artifact handoff, and any explicit risks. That keeps stronger child models free to self-report done while preventing self-acceptance from satisfying parent goal completion.

Mechanical gates should be packet-quality gates, not arbitrary-task-success gates. The runtime can require and derive concrete facts such as final-report presence, status transition validity, changed-file refs, validation command exit codes, artifact refs, blocker text, provider/tool failure metadata, and updated timestamps. If the child attempts to finish without enough packet structure, the runtime should mark the packet incomplete, ask for a structured report, or surface a blocker rather than silently accepting the work. It should not claim semantic success for open-ended tasks just because those facts exist.

Reviewer routing should stay boundary-based. The parent model can usually review the packet directly because it has the user context and original delegation intent. A separate reviewer model is useful for high-risk diffs, broad edits, ambiguous validation, or cases where the parent wants an independent pass. Either way, the child should not silently self-accept required work.

Reviewer routing should also become structured data on the review packet. Today the watcher prompt can offer an `independent_review` path, but the durable state should eventually carry the recommendation so UI, tests, and parent prompts do not have to infer it from prose.

Suggested review-routing fields:

- `independentReviewRecommended`: boolean derived at submission/review-packet update time.
- `reviewerRoutingReasons`: short reason codes such as `packet_quality_incomplete`, `packet_quality_weak`, `low_confidence`, `validation_failed`, `validation_missing`, `broad_edit_surface`, `high_risk_files`, `provider_failure_after_changes`, or `user_requested_independent_review`.
- `reviewerRoutingEvidence`: compact factual summary such as changed-file count, validation statuses, packet-quality status, confidence, and explicit user request marker.

These fields belong on `SubagentReviewState` or an adjacent review-packet object. They should be projected into goal/UI summaries, but not owned by the goal. They are deterministic recommendations from observed packet facts, not a semantic success/failure judgment.

Candidate lifecycle semantics:

- `running`: child is still executing.
- `blocked`: child says it cannot proceed without input or runtime observes a hard blocker.
- `submitted_for_review`: child decided it is done and produced a review packet.
- `needs_revision`: parent/reviewer found specific corrections and can message the child.
- `accepted`: parent/reviewer accepted the submission for synthesis or goal completion.
- `failed_with_artifacts`: child failed after producing recoverable work.

These do not all have to become persisted status enum values immediately. They can start as explicit review outcome fields or UI/lifecycle buckets, but the design must stop conflating child-submitted work with parent-accepted work.

## Copy-on-write default

Keep `copy_on_write` as the default for background coding subagents. It protects the user's dirty tree, allows parallel child work, and makes failed experiments recoverable.

The default is only acceptable if the isolated workspace is operational:

- Hydrate or link dependencies so focused tests resolve workspace packages.
- Preserve enough metadata to apply or inspect a patch after child failure.
- Auto-handoff changed files, diff refs, last validation output, and confidence when the provider fails before final report.
- Keep foreground/user-guided editing free to use the live workspace when the user intentionally asks for direct edits.

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

- `accepted` or current-code `completed` once the submission has been accepted
- `failed`
- `cancelled`

`submitted_for_review` and `needs_revision` are not terminal. They are review states that should remain visible until accepted, revised, cancelled, or failed.

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
- a child submits for review or needs revision
- all required children are accepted
- a stale/timeout threshold is reached
- the user explicitly requested follow-up

Do not wake the parent model for ordinary progress-only changes by default.

### Goal relationship

The heartbeat can be goal-aware, but should not be goal-owned.

If `parentGoalId` exists, the watcher should update goal-visible derived state such as required child submitted/needs-revision/accepted counts, blockers, unresolved runs, and cleanup-needed markers. If no goal exists, the watcher should still work from `parentSessionId`.

This preserves the desired model:

```text
Subagent always has parentSessionId.
Subagent optionally has parentGoalId.
Heartbeat watches active child work.
Goal passively tracks durable lifecycle when present.
Thread resumes only when there is a decision or synthesis step.
```

Goal lifecycle may still affect child runs. Stopping a goal should cancel unresolved linked children and clean eligible workspaces. Completing a goal should require accepted required children, cancel unfinished optional children, and clean or retain accepted child workspaces by policy. That is lifecycle coupling, not goal-backed orchestration: each child run still owns its worker brief, progress ledger, review state, artifacts, and workspace cleanup record.


## Phased implementation checklist

Use this as the working checklist for the bounded worker execution and heartbeat/lifecycle cleanup additions. Keep phases small enough that each can land independently.

### Phase 0: Product decision and naming

- [x] Keep goals; do not remake the goal abstraction. Done: current implementation already uses `parentGoalId` as optional durable scope.
- [x] Treat the parent thread/session as the orchestrator behavior. Done: parent sessions own model interaction and subagent tool calls.
- [x] Treat goals as passive durable lifecycle containers. Done: current goal handling gates completion/resume but does not run as a hidden orchestrator.
- [x] Confirm subagents are goal-aware, not goal-backed. Done: current `SubagentRun` records required `parentSessionId` and nullable `parentGoalId`; thread-scoped subagents already run with no goal.
- [x] Treat heartbeat as runtime infrastructure, not a model tool. Done: `createSubagentLifecycleWatcher(...)` is a runtime service and not a model-facing tool.
- [x] Rename/clarify user-facing copy where subagents sound exclusively goal-owned. Done: Settings peer-message copy now says `Scoped handoffs` instead of `Goal scoped`.
- [x] Decide whether UI should keep saying “heartbeat,” use “watcher,” or hide the term behind “background monitoring.” Done: Settings labels the preference `Background check seconds` while keeping the internal `heartbeatIntervalSeconds` contract field.

### Phase 1: Settings surface and contracts

- [x] Add `heartbeatIntervalSeconds` to subagent preferences. Done: `SubagentPreferencesSchema` includes the setting.
- [x] Default to `60` seconds. Done: contract default is `60`.
- [x] Bound accepted values to `10–3600` seconds. Done: contract and numeric Settings input enforce the same range.
- [x] Add settings-page input for heartbeat/background-check seconds. Done: Subagents Settings shows `Background check seconds`.
- [x] Confirm persisted defaults are applied consistently for new users, existing users, and missing preference records. Done: `tests/app-preferences.test.ts` covers schema defaults, empty-store bootstrap defaults, legacy persisted subagent records without `heartbeatIntervalSeconds`, and unrelated partial preference saves preserving normalized subagent defaults.
- [x] Add help text that this controls runtime checks, not parent model wake frequency. Done: Subagents Settings explains the cadence checks active child workers and does not wake the parent model every interval.

### Phase 2: Bounded worker execution contract

This phase adds runtime-owned progress control for active child work. It should land before or alongside watcher work so heartbeat/stale logic can observe structured child state instead of raw transcript patterns.

- [x] Extend `openpond_subagent_start` input with a structured worker brief: `plan`, `targetFiles`, `acceptanceCriteria`, `validationCommands`, and `stopConditions`. Done: `workerBrief` is parsed by `SubagentWorkerBriefSchema`.
- [x] Add first-class typed worker state, such as `SubagentWorkerBriefSchema` and `SubagentProgressSchema`, rather than storing the design as a permanent metadata blob. Done: `SubagentRun` now carries `workerBrief`, `progress`, and `review`.
- [x] Add first-class child submission/review packet state so child final report means submitted-for-review, not accepted. Done: background child and child follow-up finalization set `status: "submitted_for_review"` and `review.status: "submitted_for_review"`.
- [x] Add review outcome state or derived lifecycle buckets for submitted, needs revision, accepted, and failed with artifacts. Done: contracts/server/web runtime recognize submitted, needs-revision, accepted, needs-user-input, and failed-with-artifacts states.
- [x] Update known parent model/tool launch paths to provide or construct a valid brief before a child run is persisted. Done: `startSubagentFromModelTool(...)` constructs a typed brief from objective/context when the tool caller omits fields.
- [x] Add runtime-derived child phase tracking for `orient`, `edit`, `validate`, `report`, and `submitted`. Done: launch/running/failure/submission paths set lifecycle phases, and child tool-event evidence infers `edit` and `validate` before final submission.
- [x] Add a runtime-derived progress ledger for inspected files/resources, repeated searches/reads, changed files, validation attempts, latest meaningful activity, and current blocker. Done: the runner derives these fields from `tool.completed`, `workspace_action_result`, and `command.output` events and preserves failed validation blockers in the review packet.
- [x] Detect repeated low-value exploration and steer the child to edit, validate, report, or ask a blocker question instead of generic continuation. Done: child hosted tool loops now inject advisory runtime steering after repeated search/read/command patterns using role-configured thresholds; default policy preserves second-repeat steering, while role overrides can delay or disable early steering. `tests/turn-runner-subagents.test.ts` covers default repeated-search steering before validation and a tuned threshold that records repeated search evidence without warning too early.
- [x] Preserve true command failure status for validation commands, including piped commands such as `bun test ... | tail`. Done: local command access runs through Bash `pipefail`, sandbox `/exec` requests are pipefail-wrapped before API execution, and regressions cover both command paths.
- [x] Make copy-on-write worktrees dependency-ready enough for focused repo tests, or route validation through a dependency-aware workspace command path. Done: local git worktrees link ignored parent dependency artifacts such as root/workspace `node_modules`, record link metadata, and `tests/turn-runner-subagents.test.ts` runs `bun test fixture.test.ts` inside the child worktree against a dependency only present in the parent ignored `node_modules`.
- [x] Auto-handoff recoverable child work when a provider failure occurs after file changes: changed files, diff ref, last validation output, confidence, and unresolved blockers. Done: failed child turns capture git-worktree changed files, durable patch/diff refs, validation attempts with output summaries, low confidence, blockers, and `metadata.failureHandoff`; `tests/turn-runner-subagents.test.ts` covers a provider failure after validation plus workspace mutation.
- [x] Let the parent/reviewer evaluate submitted child work at review boundaries and send a corrective message back to the child when revision is needed. Done: `openpond_subagent_review` accepts submitted work without patch approval, marks `needs_revision`/`needs_user_input`, records reviewer fields, and delivers interrupt-priority correction text back to the child by default.

### Phase 2.5: Completion and review decision model

This phase keeps child autonomy without letting a child self-accept required work. The child model decides when to stop and submit; OpenPond records that as a deterministic lifecycle event; parent or reviewer judgment decides acceptance.

- [x] Treat child self-reported done as `submitted_for_review`, not accepted completion. Done: child finalization paths set `status: "submitted_for_review"` and `review.status: "submitted_for_review"` instead of satisfying required goal work.
- [x] Keep stop-and-submit child-owned rather than pre-judged. Done: the child final report path creates a submitted review packet directly; the runtime and watcher only package evidence and route review after that boundary.
- [x] Keep runtime evidence as review-packet input rather than a separate semantic truth engine. Done: progress, validation attempts, changed-file refs, patch refs, artifacts, blockers, and provider/tool failures are captured as structured run/report/review evidence.
- [x] Add structured packet-quality facts without turning them into arbitrary-task-success gates. Done: `SubagentReviewPacketQualitySchema` records `reviewable`, `weak`, or `incomplete`; `SubagentReviewPacketQualityEvidenceSchema` carries derived counts for summary presence/length, requested and attempted validation, failed validation, tests, changed files, patch/diff refs, artifacts, findings, blockers, and unvalidated workspace changes. Missing final summary becomes an incomplete blocker, while missing requested validation or unvalidated workspace changes stay submitted but are low-confidence, human-review-recommended weak packets.
- [x] Keep required goal completion gated on parent/reviewer acceptance. Done: goal completion uses accepted semantics, so submitted-for-review and needs-revision children remain unresolved.
- [x] Require explicit acknowledgement before blocked/failed/cancelled required children stop blocking goal completion. Done: `openpond_subagent_review` supports `decision: "dismiss"` for blocked, failed, failed-with-artifacts, or cancelled runs; dismissed runs resolve goal gating without increasing accepted counts and emit `subagent.dismissed`.
- [x] Allow corrective review loops. Done: parent/reviewer can mark `needs_revision` or `needs_user_input`, and revision feedback is delivered back into the child context.
- [x] Harden parent/reviewer prompt shape so boundary review always receives the original objective, worker brief, final report, runtime evidence, validation output, diff/artifact refs, blockers, and explicit outcome options. Done: watcher parent-wake prompts now render bounded review packets and explicit accept/needs-revision/needs-user-input/independent-review/retry-or-cancel decisions; `tests/subagent-lifecycle-watcher.test.ts` asserts the prompt carries those fields.
- [x] Add regression coverage that a child final report can self-submit without external pre-judging, but cannot self-accept or satisfy required goal completion until a parent/reviewer accepts it. Done: `tests/turn-runner-subagents.test.ts` covers child self-review rejection, submitted-for-review required children blocking goal completion, and parent/reviewer acceptance as the resolving step.
- [x] Define when to route to a separate reviewer model instead of parent review: high-risk diff, broad edit surface, failed/ambiguous validation, low confidence, or user-requested independent review. Done: boundary wake prompts include an `independent_review` option for those cases before acceptance.

### Phase 2.6: Structured reviewer routing metadata

This phase makes independent-review routing durable and inspectable without turning every child completion into a judge run.

- [x] Add first-class review-routing metadata to `SubagentReviewState` or a sibling review-packet object: `independentReviewRecommended`, `reviewerRoutingReasons`, and compact evidence details. Done: `SubagentReviewStateSchema` now carries those fields, backed by `SubagentReviewRoutingEvidenceSchema` defaults.
- [x] Derive routing recommendations from observed packet facts: packet-quality status/evidence, child confidence, validation failure or missing validation, changed-file breadth, high-risk paths, provider/tool failure after changes, and explicit user request. Done: `subagentReviewRoutingRecommendation(...)` derives advisory reasons for submitted packets and failure-with-artifacts handoffs.
- [x] Keep the recommendation advisory. The parent can accept directly, start an independent reviewer, ask for revision, or ask the user; the child still stops at `submitted_for_review`. Done: routing metadata does not change child stop, review status, or goal-completion acceptance semantics.
- [x] Make reviewer-routing reason codes typed once the initial taxonomy exists. Done: `SubagentReviewRoutingReasonSchema` is now a closed contract enum, the runner derives typed reason codes, and the contract rejects unknown durable routing reasons.
- [x] Make broad-edit and high-risk routing thresholds configurable once defaults are proven. Done: `SubagentReviewRoutingPolicySchema` lives on role settings with default broad-edit threshold `8` and default high-risk path patterns; role overrides can tune the file threshold and regex patterns without changing packet semantics.
- [x] Feed structured routing facts into watcher parent-wake prompts instead of relying only on prose rules. Done: lifecycle wake packets include packet-quality status/evidence, `Independent review recommended`, reason codes, and compact routing evidence.
- [x] Project routing facts into web runtime final-result summaries and Goal details so broad or weak packets are visible before acceptance. Done: `SubagentRuntimeStatus.finalResults` carries packet-quality status/evidence plus routing fields, and Goal details renders packet-quality evidence, independent-review recommendation, and reason labels.
- [x] Add focused tests for contract defaults, runtime derivation, watcher prompt rendering, and UI projection. Done: focused contracts, runner, watcher, runtime-index, and Goal details tests assert the packet-quality evidence and routing fields/display.

### Phase 3: Runtime watcher foundation

This phase is not covered by the existing subagent queue or child-to-parent mailbox wake. It should introduce a runtime watcher that observes stored run state and emits/wakes only on policy-relevant lifecycle transitions.

- [x] Add a runtime subagent watcher/heartbeat service. Done: `createSubagentLifecycleWatcher(...)` is wired into server startup/shutdown and uses the subagent work queue.
- [x] Start the watcher only when non-terminal child runs exist. Done: server startup enables the watcher without queuing a tick or interval when no active child runs exist; subagent run state writes call `notifySubagentRunStateChanged(...)` to arm the watcher when active work appears.
- [x] Stop or idle the watcher when all watched child runs are terminal. Done: schedule refresh clears the interval when active child runs disappear, while still allowing a one-shot state-change tick for recent terminal required failure/acceptance attention.
- [x] Watch by `parentSessionId` first and `parentGoalId` when present. Done: SQLite exposes `listSubagentRunScopes(...)`; watcher ticks discover active/recent terminal scopes first, then query active, stale, failed, and accepted runs inside each exact parent/goal scope, including thread-scoped runs where `parentGoalId` is null.
- [x] Prefer structured run state over transcript scanning. Done: watcher reads `listActiveSubagentRuns(...)` and `listStaleSubagentRuns(...)`, not transcripts.
- [x] Record watcher ticks/events without waking the parent model by default. Done: active ticks append `diagnostic` events with `kind: "subagent_lifecycle_watcher_tick"` and `wakeQueued: false`.

### Phase 4: Status and stale detection

- [x] Store internal update timestamps for subagent rows. Done: SQLite stores `subagent_runs.updated_at` and orders list results by it.
- [x] Provide a generic run listing query. Done: `listSubagentRuns({ parentSessionId, parentGoalId, childSessionId, status, limit })` exists.
- [x] Expose reliable `updatedAt`/last-activity data for subagent runs. Done: `SubagentRun.updatedAt` is hydrated from SQLite `subagent_runs.updated_at`.
- [x] Add a query like `listActiveSubagentRuns(...)` or a watcher-local helper that centralizes active status selection. Done: SQLite store helper centralizes non-terminal status selection.
- [x] Add a query like `listStaleSubagentRuns({ olderThanMs, statuses })`. Done: SQLite store helper derives stale runs by `updated_at` cutoff and status set.
- [x] Define stale as derived state first unless a persisted `stale` status becomes necessary. Done: stale is currently a query/watch result, not a persisted run status.
- [x] Mark stale optional runs as attention-needed or cancellable. Done: watcher emits deduped `subagent.stale` receipts with `attentionNeeded: true`, `cancellable: true`, and `policy: "optional_attention"` for optional stale runs without waking the parent model.
- [x] Auto-cancel optional stale working-state runs after a longer grace threshold. Done: watcher cancels optional stale runs in `queued`, `running`, `blocked`, or `needs_resume` after the auto-cancel grace window, records `metadata.staleAutoCancel`, emits `subagent.cancelled`, and best-effort interrupts the child session while leaving submitted/review states and required stale runs visible.
- [x] Keep stale required runs visible as blockers. Done: watcher emits `required_stale` lifecycle wake reasons, `requiredStaleRunIds`, and parent follow-up prompts for required stale runs.

### Phase 5: Wake routing policy

Existing explicit child-to-parent mailbox messages already queue or defer a bounded parent wake. The remaining rows below are for heartbeat-derived lifecycle events.

- [x] Queue parent wake for explicit child-to-parent mailbox handoffs. Done: `openpond_subagent_send_message` records parent wake delivery metadata and enqueues an idle parent follow-up.
- [x] Do not wake parent for ordinary routine lifecycle receipts by default. Done: current mailbox/lifecycle behavior and watcher diagnostic ticks avoid routine parent wakes.
- [x] Make wake reasons explicit for mailbox handoffs. Done: delivery metadata records queued, deferred, already-queued, missing-parent, active-parent, and loop-limit reasons.
- [x] Queue parent wake when a required child blocks or fails and the watcher observes that transition. Done: watcher queues parent follow-up for required `blocked`, recent terminal `failed`, and `failed_with_artifacts` runs with explicit reason keys.
- [x] Queue parent wake when a required child submits for review, needs revision, or fails with artifacts and watcher policy says synthesis/review is needed. Done: watcher queues deduped parent follow-up for required `submitted_for_review`, `needs_revision`, `needs_user_input`, and `failed_with_artifacts` states.
- [x] Queue parent wake when all required children are accepted and watcher policy says synthesis is needed. Done: watcher detects a recent accepted required run, verifies every required run in that parent/goal scope is accepted, and queues a deduped `required_all_accepted` parent wake.
- [x] Queue parent wake on stale/timeout threshold. Done: required stale runs produce `required_stale` wake groups; optional stale runs emit `subagent.stale` attention receipts without parent wake.
- [x] Make watcher wake reasons explicit and visible in runtime events. Done: watcher tick and wake diagnostics include wake keys, run ids, statuses, reasons, queued/skipped parent sessions, and skip reasons.
- [x] Ensure parent model turns do not poll on a sleep loop. Done: routine ticks do not wake, active parent turns are skipped, and lifecycle wakes are deduped by parent/goal scope plus run id/status/`updatedAt`.

### Phase 6: Goal-aware derived state

- [x] Gate goal completion on unresolved required children. Done: `openpond_goal_control complete` fails while required child runs are not completed.
- [x] Mark queued/running goal child runs as `needs_resume` when the parent goal resumes. Done: goal resume appends parent-visible `subagent.blocked` receipts for affected child runs.
- [x] Keep core thread-scoped subagents working when no goal exists. Done: `parentGoalId` is nullable and child runs always have `parentSessionId`.
- [x] If `parentGoalId` exists, update runtime-derived goal-visible child state. Done: goal-control now emits post-lifecycle `thread_goal` diagnostics with a typed `goal.subagents` snapshot derived from linked `SubagentRun` rows, including required active/submitted/revision/user-input/accepted/blocking/unresolved counts, cleanup-needed count, and compact run summaries; web runtime indexes parse and retain that snapshot.
- [x] Track required active, required submitted-for-review, required needs-revision, required blocking, and required unresolved counts separately. Done: `SubagentRuntimeStatus` exposes required active/submitted/revision/blocking/accepted/unresolved counts and `GoalDetailsView` renders them.
- [x] Update goal completion gates so submitted-for-review and needs-revision children remain unresolved until accepted or explicitly dismissed. Done: goal completion now checks accepted/dismissed review semantics rather than raw `completed`; dismissed blocked/failed/cancelled children are resolved but not counted as accepted.
- [x] Make goal completion/stopping cleanup/archive policies apply to linked child runs. Done: goal stop cancels unresolved linked child runs, cleans eligible accepted/cancelled workspaces, and archives safe child sessions; goal complete requires accepted required children, cancels unfinished optional children, cleans or retains accepted/cancelled workspaces by policy, archives child sessions, and records cleanup/archive metadata on runs plus `goal.subagents` snapshots.
- [x] Make goal restart supersede prior linked child runs without counting them as accepted or unresolved. Done: `openpond_goal_control restart` marks prior linked child runs `superseded`, interrupts active child turns when present, emits `subagent.superseded`, preserves prior review/report evidence, and projects superseded runs as terminal/resolved-but-not-accepted in both `goal.subagents` and UI runtime counts.

### Phase 7: Cleanup and archive behavior

- [x] Clean git-worktree isolated workspace on explicit cancellation. Done: `openpond_subagent_cancel` interrupts the child and calls git-worktree cleanup unless `cleanupWorkspace` is false.
- [x] Add or harden `cleanupSubagentRun(runId, reason, policy)`. Done: `cleanupSubagentRun(...)` records `metadata.lifecycleCleanup`, emits `subagent.cleanup`, and centralizes accepted/cancelled workspace cleanup policy.
- [x] Cleanup temporary worktrees/sandbox forks after safe terminal states. Done: local git worktrees are removed after accepted applied-patch/read-only states, explicit cancellation, goal-stop cancellation, and goal-complete optional cancellation; sandbox forks are deleted through the sandbox lifecycle API on discard-safe cleanup paths such as explicit cancellation and goal lifecycle cancellation, while changed accepted sandbox handoffs remain retained for inspection until reviewed/applied.
- [x] Retain reports, artifacts, patch refs, tests, and important messages. Done for local worktrees: captured patches now live under durable attachments before worktree cleanup, while reports/tests/messages remain on the run/events.
- [x] Define default retention for child messages and non-workspace artifacts. Done: `SubagentRun.evidenceRetention` defaults to `retain_with_parent` with `messageRetentionDays: null`, `artifactRetentionDays: null`, and `cleanupAfterExpiry: false`; cleanup/archive metadata carries the same policy so evidence refs are not treated as workspace-expiring data.
- [x] Archive completed child sessions after parent/goal completion. Done: goal completion archives accepted and goal-cancelled optional child sessions, goal stop archives accepted/cancelled safe child sessions, child sessions receive `metadata.subagentArchive`, runs receive `metadata.childSessionArchive`, and `subagent.archived` receipts record archive outcomes.
- [x] Allow retain-for-inspection for failures/cancellations. Done for current policy: failed runs and accepted-but-unapplied changed workspaces are retained with 7-day retain-for-inspection metadata; explicit cancellation still cleans unless the caller passes `cleanupWorkspace: false`.
- [x] Handle patch-approval accept/decline/cancel/conflict without losing copy-on-write evidence. Done: accepted patch approvals apply the durable patch into the parent checkout and remove the child worktree; declined and cancelled approvals keep the child worktree readable, record `workspaceHandoff.applyResult.status` plus 7-day retained-workspace metadata, and emit `subagent.workspace_retained`; apply conflicts leave the approval pending and preserve both the parent conflict file and child worktree for retry.
- [x] Enforce retained-workspace expiry without requiring an active child run. Done: watcher scans retained workspace metadata, schedules a future tick for the next expiry, and calls runner-owned `retention_expired` cleanup so expired retained workspaces are removed instead of re-retained.
- [x] Surface retained-workspace expiry before automatic cleanup. Done: watcher emits a deduped `subagent.workspace_retention_expiring` warning 24 hours before expiry, records warning metadata without changing the run's lifecycle `updatedAt`, schedules the warning deadline even when no child runs are active, and does not wake the parent model by default.
- [x] Emit cleanup started/completed/failed events. Done: `subagent.cleanup` emits `started`, `completed`, or `failed` status with cleanup metadata.

### Phase 8: UI and observability

- [x] Show current active, blocked, completed, required-open, usage, evidence, checks, and task graph state. Done: current runtime projection and Goal details panel render these aggregates.
- [x] Show heartbeat/watcher-derived status without implying the model is awake. Done: `SubagentRuntimeStatus.watcher` derives the latest `subagent_lifecycle_watcher_tick` diagnostic and Goal details renders `Background check` with `routine check` copy for non-waking ticks.
- [x] Show active, blocking, unresolved, terminal, and archived buckets as lifecycle/UI buckets. Done: `SubagentRuntimeStatus` exposes lifecycle run lists/counts and Goal details plus sidebar popovers render the buckets.
- [x] Show submitted-for-review, needs-revision, accepted, and failed-with-artifacts as review lifecycle buckets without implying child submission equals accepted completion. Done: review buckets are separated from accepted/completed counts, and required unresolved stays separate from accepted.
- [x] Show latest meaningful update from structured state. Done: runtime derives `latestMeaningfulUpdate` from progress, report summary, blocker, or error fields and Goal details renders it as the child role/status plus message.
- [x] Show finalized child result summaries without expanding full child transcripts. Done: `SubagentRuntimeStatus.finalResults` keeps summary, findings, changed files, refs, tests, validation attempts, blockers, confidence, retained-workspace expiry metadata, and important handoff/question/artifact messages, while Goal details renders a compact `Child Results` section and leaves full payload inspection behind Raw State.
- [x] Add “cleanup/archive” controls where appropriate. Done: contracts define explicit lifecycle action requests, the app server exposes `POST /v1/subagents/:runId/lifecycle`, `turn-runner.ts` runs manual cleanup/archive through the same retention/archive helpers, and Goal details renders Clean/Archive controls for eligible terminal child runs.
- [x] Add operational events for stale detected, wake queued, wake skipped, workspace retained, retained-workspace expiry warning, archived, and superseded. Done: stale detected emits typed `subagent.stale`; wake queued/skipped diagnostics, cleanup, workspace-retained, `subagent.workspace_retention_expiring`, archived, and `subagent.superseded` events exist with structured run/lifecycle metadata.

### Phase 9: Verification

Use the verifiable desktop harness as the primary end-to-end product test path for this addition. See `docs/working-docs/agent-harness/2026-07-08-verifiable-desktop-harness.md` and the `openpond-desktop-harness` skill for scenario authoring rules.

- [x] Baseline desktop subagent scenario suite exists. Done: `bun run test:desktop:subagents` now runs heartbeat Settings, progress-only no-wake, thread-scoped watcher, stale policy, visible lifecycle, running state, child-to-parent handoff wake, watcher-submission wake, parent review/revision loop, bounded-worker contract, blocked approval, and goal-scoped details scenarios.
- [x] Unit test preference bounds/defaults. Done: `tests/app-preferences.test.ts` covers `heartbeatIntervalSeconds` default `60`, accepted bounds `10` and `3600`, rejected out-of-range values, and persisted default normalization for empty/legacy/partial records.
- [x] Unit test structured subagent launch brief parsing, persistence, and required server-constructed briefs for every launch path. Done: `tests/subagent-contracts.test.ts`, `tests/capability-tool-registry.test.ts`, and `tests/turn-runner-subagents.test.ts`.
- [x] Unit test child final report creates submitted-for-review/review-packet state rather than accepted completion. Done: `tests/turn-runner-subagents.test.ts` covers submitted-for-review finalization, child self-review rejection, and submitted required children blocking goal completion until parent/reviewer acceptance.
- [x] Unit test parent/reviewer can mark a submission accepted or needs revision and route a corrective message back to the child. Done: `tests/turn-runner-subagents.test.ts` covers explicit `openpond_subagent_review` acceptance without patch approval and needs-revision correction delivery into the child turn context.
- [x] Unit test progress-ledger updates and repeated-exploration steering. Done: `tests/turn-runner-subagents.test.ts` covers inspected file derivation, repeated search recording, validation-attempt capture, output-evident piped validation failure recording, and repeated-search steering injection.
- [x] Unit test validation command exit-status preservation for piped commands. Done: `tests/openpond-command-access.test.ts` proves local `exec_command` reports the failing pipeline stage exit code, `tests/sandbox-env-normalization.test.ts` proves sandbox `/exec` requests are pipefail-wrapped before API execution, and `tests/turn-runner-subagents.test.ts` still covers output-evident failed validation in the progress ledger.
- [x] Unit test failed-child diff handoff when a provider error occurs after workspace changes. Done: `tests/turn-runner-subagents.test.ts` covers a stored child provider failure after validation and workspace mutation, asserting `failed_with_artifacts`, changed files, patch/diff refs, last validation output summary, low confidence, unresolved blockers, and durable patch handoff.
- [x] Integration test: copy-on-write coding subagent can run a focused repo test with workspace packages resolvable. Done: `tests/turn-runner-subagents.test.ts` creates a local git repo, leaves `fixture-dep` only in ignored parent `node_modules`, starts a copy-on-write coding child, and verifies `bun test fixture.test.ts` passes from the child worktree.
- [x] Unit test watcher start/stop behavior. Done: `tests/subagent-lifecycle-watcher.test.ts` covers idle startup without scheduling, dynamic arming on active child state, interval clearing when active runs disappear, status, and stop.
- [x] Unit test wake policy cases. Done: `tests/subagent-lifecycle-watcher.test.ts` covers required submitted/stale/failed parent wakes, recent terminal failed-only wake, all-required-accepted synthesis wake, dedupe, and active-parent skip behavior.
- [x] Unit test boundary review prompt shape. Done: `tests/subagent-lifecycle-watcher.test.ts` asserts required submitted wake prompts include objective, worker brief, report summary, patch/diff refs, runtime validation evidence, and explicit review outcome options.
- [x] Unit test stale detection. Done: `tests/subagent-store.test.ts` covers stale query derivation and `tests/subagent-lifecycle-watcher.test.ts` covers watcher stale counts plus optional stale attention without parent wake.
- [x] Unit test optional stale auto-cancel policy. Done: `tests/subagent-lifecycle-watcher.test.ts` covers grace-threshold cancellation for optional stale working-state runs, child-turn interrupt evidence, `metadata.staleAutoCancel`, `subagent.cancelled`, and non-cancellation for required stale and submitted-for-review optional runs.
- [x] Integration test: parent starts child, parent idles, child submits for review, watcher queues a policy-driven parent wake when appropriate. Done: `tests/turn-runner-subagents.test.ts` starts a required research child through the real `openpond_subagent_start` path, drains the child queue to `submitted_for_review`, verifies the parent is idle, ticks `createSubagentLifecycleWatcher(...)`, drains the parent wake queue into a real parent turn with `subagentLifecycleWake` metadata, and asserts a second tick is deduped.
- [x] Integration test: no goal present, subagent still works under parent session. Done: `tests/turn-runner-subagents.test.ts` starts a read-only research child without an active goal, drains the child queue, and asserts `parentSessionId` linkage, null `parentGoalId`, child-session metadata, subagent usage attribution with null goal id, and `subagent.submitted` receipt projection without goal diagnostics.
- [x] Integration test: goal present, derived required counts update. Done: `tests/turn-runner-subagents.test.ts` asserts goal complete/stop append latest `thread_goal.goal.subagents` counts after linked child cancellation/cleanup, and `tests/runtime-indexes.test.ts` asserts the web runtime parser retains the snapshot.
- [x] Integration test: goal stop cancels/cleans active child runs. Done: `tests/turn-runner-subagents.test.ts` covers stopping an OpenPond goal and cancelling, cleaning, and archiving a linked active child run.
- [x] Desktop harness scenario: heartbeat setting persists in Settings and makes clear it controls runtime checks, not parent model wake frequency. Done: `tests/desktop-scenarios/subagent-heartbeat-settings.ts` resets the preference to `60`, opens Settings > Subagents, asserts visible label/help text plus `10`/`3600` bounds, saves `25`, verifies `/v1/bootstrap` readback, reloads the renderer, and verifies the saved value is still visible.
- [x] Desktop harness scenario: parent starts a child, parent turn idles, watcher observes submitted-for-review state, and parent wake is queued only for a meaningful event. Done: `tests/desktop-scenarios/subagent-watch-submission-wake.ts` uses `openpond-scripted-subagent-watch-submission`, asserts a single parent start, single watcher wake diagnostic, submitted UI, compact child result, and a single lifecycle-wake assistant response.
- [x] Desktop harness scenario: child progress-only updates do not wake the parent model every heartbeat interval. Done: `tests/desktop-scenarios/subagent-heartbeat-no-progress-wake.ts` verifies an interval `subagent_lifecycle_watcher_tick` before submission with `wakeQueued: false`, no lifecycle wake assistant response, and later meaningful submitted-for-review wake behavior.
- [x] Desktop harness scenario: thread-scoped subagent without a goal is still watched and reports status correctly. Done: `tests/desktop-scenarios/subagent-heartbeat-thread-scoped.ts` verifies null `parentGoalId`, thread-scoped watcher wake diagnostics, parent wake response, and Goal details subagent visibility without making a goal mandatory.
- [x] Desktop harness scenario: goal-scoped subagent updates goal-visible derived counts/status without making the goal an active orchestrator. Done: `tests/desktop-scenarios/goal-scoped-subagent-details.ts` asserts the composer goal strip, right-sidebar Goal details, required submitted row, child `parentGoalId`, and submitted activity while the parent thread remains the orchestrator.
- [x] Desktop harness scenario: stale/timeout child is surfaced as attention-needed or blocking according to required/optional policy. Done: `tests/desktop-scenarios/subagent-heartbeat-stale.ts` ages required and optional child runs through SQLite, verifies required `subagent.stale` plus parent wake, verifies optional `subagent.stale` without parent wake, and proves both children can still submit afterward.
- [x] Desktop harness scenario: parent/reviewer can request child revision and later accept the revised submission. Done: `tests/desktop-scenarios/subagent-review-revision-loop.ts` starts a required child, observes the watcher-queued submitted-for-review wake, marks the first packet `needs_revision`, verifies interrupt-priority correction delivery to the child, submits a revised packet, accepts it on the second watcher wake, and asserts exactly two review decisions plus two submission receipts.
- [x] Desktop harness scenario: bounded coding worker receives a structured brief, edits only the copy-on-write child worktree, validates with a real command, and submits for review without self-accepting. Done: `tests/desktop-scenarios/subagent-bounded-worker-contract.ts` asserts the coding role, `copy_on_write` isolation, persisted worker brief, repeated-search ledger evidence, passed validation command, durable workspace handoff patch, child proof file presence, parent checkout absence, and submitted-for-review state.
- [x] Run typecheck, focused unit tests, and relevant desktop harness scenarios. Done: `bun run typecheck`, focused queue/lifecycle/chat/scripted tests, focused new desktop scenarios, and the full 12-scenario `bun run test:desktop:subagents` suite pass for this slice.

### Phase 10: Parent delegation policy

This phase controls how readily the parent orchestrator uses the existing subagent tools. It does not add goals, change worker budgets, or make children self-orchestrating.

- [x] Add a typed `manual | balanced | proactive` delegation mode with `balanced` as the global default.
- [x] Persist a nullable per-session override and resolve it as session override -> global default.
- [x] Add an icon menu beside voice input with `Use default`, `Manual`, `Balanced`, and `Proactive` choices; carry pre-send choices into newly created sessions.
- [x] Keep the selector off child, Codex-history, team-chat, and globally disabled subagent surfaces.
- [x] Inject a short parent-only system instruction that changes delegation threshold while preserving parent planning, coordination, and synthesis.
- [x] Keep explicit user delegation requests higher priority than the selected default behavior.
- [x] Record the resolved mode and source on turn metadata for diagnostics.
- [x] Add the global default control to Subagents Settings.
- [x] Verify contract defaults, session persistence, parent-only prompt injection, focused runtime behavior, typecheck, and production web build. Done: focused preferences/session/runner tests pass, child prompt coverage rejects parent policy leakage, and the composer uses a neutral `SUB` trigger with the mode menu beside voice input.

## Cleanup priorities

### 1. Stale and orphaned run handling

Add explicit detection and handling for subagents that are no longer making progress.

Candidate stale statuses:

- `queued`
- `running`
- `blocked`
- `needs_resume`

Possible policy:

- Mark old inactive runs as stale or needs attention. Done for active watcher states through typed `subagent.stale` receipts.
- Cancel stale optional runs after a threshold. Done for optional `queued`, `running`, `blocked`, and `needs_resume` runs after the watcher auto-cancel grace window.
- Keep required stale runs visible as blockers. Done through required stale wake groups and no auto-cancel for required runs.
- Cancel active orphaned runs whose parent session is missing or archived. Done through watcher orphan auto-cancel with `metadata.orphanAutoCancel`, `subagent.cancelled`, best-effort child-turn interrupt, and active count removal for that tick.
- Avoid silently counting old failed/cancelled/blocked runs as normal open work. Done for active orphaned runs and terminal failed/cancelled rows; blocked still remains an explicit attention state rather than being silently treated as healthy open work.

### 2. Workspace cleanup

Make cleanup explicit and observable for isolated workspaces.

Cases to verify:

- Accepted read-only subagent.
- Accepted read/write subagent after review-packet handoff.
- Cancelled queued subagent.
- Cancelled running subagent.
- Failed setup.
- Patch approval accepted, declined, cancelled, or conflicted. Done: accepted applies then cleans; declined/cancelled retain the child worktree with explicit `applyResult`, 7-day retained-workspace metadata, and `subagent.workspace_retained`; conflicts leave the approval pending and preserve both workspaces.
- Parent goal stopped.
- Parent goal completed.

Suggested policy:

- Retain final report, artifact refs, patch refs, tests, and key messages.
- Clean temporary worktrees or sandbox forks by default after terminal states.
- Allow retain-for-inspection when cancellation or failure needs debugging; retained child workspaces now default to 7 days and carry `expiresAt` plus `cleanupAfterExpiry` metadata that the lifecycle watcher enforces through runner-owned cleanup.

### 3. Parent goal lifecycle coupling

Parent goal state should drive child run state.

Candidate rules:

- Parent stopped: cancel active child runs and cleanup temporary workspaces when safe.
- Parent completed: archive child sessions, retain final reports/artifacts, cleanup workspaces.
- Parent restarted: mark old child runs `superseded`, interrupt active child turns when possible, and retain prior review/report evidence for inspection without counting it toward the restarted goal's accepted work.
- Parent paused: pause or avoid starting new child runs.
- Parent resumed: resume eligible child runs or re-plan delegation.

### 4. Required-run semantics

Separate unresolved required work from active required work.

Useful buckets:

- `requiredActiveCount`: required runs in `queued`, `running`, or `needs_resume`.
- `requiredSubmittedForReviewCount`: required runs with child submissions awaiting parent/reviewer decision.
- `requiredNeedsRevisionCount`: required runs where parent/reviewer asked the child for corrections.
- `requiredBlockingCount`: required runs in `blocked`, `failed`, `failed_with_artifacts`, or `cancelled`, excluding runs the parent explicitly dismissed.
- `requiredAcceptedCount`: required runs accepted by the parent/reviewer.
- `requiredUnresolvedCount`: required runs that are not accepted or explicitly dismissed.

This avoids treating all non-accepted required runs as the same kind of open work.

### 5. Archive and compact child outputs

Create a finalized child result view.

Done: `SubagentRuntimeStatus.finalResults` derives a compact result packet from each finalized run's report, progress ledger, review state, evidence refs, validation attempts, and important subagent messages. Goal details renders these packets in `Child Results`; full structured payloads stay behind Raw State instead of being the default reading path.

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
- dismissed
- parent stopped children
- patch applied/declined/cancelled/conflict-pending

This helps both UI and operational debugging.

## Product shape

The user should not experience subagents as many random chats. They should experience them as a thread-local, goal-aware worker panel.

Recommended UX:

- Compact worker list by default.
- Status chips from persisted run state plus review outcome: queued, running, blocked, submitted for review, needs revision, accepted, needs resume, failed, failed with artifacts, cancelled, superseded.
- UI/lifecycle buckets where useful: active, submitted for review, needs revision, accepted, unresolved, terminal, archived.
- Required/optional marker.
- Latest meaningful update.
- Review packet/final report preview.
- Parent/reviewer correction trail when a child needs revision.
- Cleanup/archive controls.
- Expandable full details when needed.

## Near-term implementation slice

A practical first slice from the current code:

1. Add first-class structured worker brief/progress state and construct a required typed brief for every known launch path.
2. Add child submission/review-packet state so child final report becomes submitted-for-review, not accepted completion.
3. Add parent/reviewer review outcome handling: accepted, needs revision, needs user input, or failed with artifacts.
4. Add phase/progress-ledger tracking and repeated-exploration steering in the hosted child tool loop.
5. Add `updatedAt` or equivalent last-activity data to the subagent run contract/API projection.
6. Add active/stale run helpers such as `listActiveSubagentRuns(...)` and `listStaleSubagentRuns({ olderThanMs, statuses })`.
7. Add the watcher service that consumes `heartbeatIntervalSeconds`, emits explicit watcher events without routine parent wakes, and then tighten scheduling so it starts only when active children exist.
8. Add a cleanup/archive service such as `cleanupSubagentRun(runId, reason, policy)`.
9. Wire parent goal stop/complete to child cancellation/archive/cleanup.
10. Update UI aggregation to separate required active, required submitted-for-review, required needs-revision, required blocking, required unresolved, terminal, and archived buckets.
11. Add event coverage for cleanup/archive/stale/watcher-wake/review transitions.

## Desktop harness verification plan

Use the verifiable desktop harness as the acceptance test for subagent heartbeat/lifecycle additions, not just backend unit tests. The harness is the right proof layer because the feature spans settings, runtime events, parent/child sessions, optional goals, UI status, and parent wake behavior.

Reference: `docs/working-docs/agent-harness/2026-07-08-verifiable-desktop-harness.md`.

Recommended scenario additions under `tests/desktop-scenarios/`:

- `subagent-heartbeat-settings`: proves the Settings page exposes and persists `heartbeatIntervalSeconds` with bounds/default behavior and help text. Added in `tests/desktop-scenarios/subagent-heartbeat-settings.ts`.
- `subagent-watch-submission-wake`: proves a child can submit for review while the parent is idle, the watcher records the meaningful event, and a parent wake is queued once when policy requires review or synthesis. Added in `tests/desktop-scenarios/subagent-watch-submission-wake.ts`.
- `subagent-heartbeat-no-progress-wake`: proves ordinary progress-only updates do not resume the parent model on every heartbeat. Added in `tests/desktop-scenarios/subagent-heartbeat-no-progress-wake.ts`.
- `subagent-heartbeat-thread-scoped`: proves subagents with `parentSessionId` and no `parentGoalId` are still watched and visible. Added in `tests/desktop-scenarios/subagent-heartbeat-thread-scoped.ts`.
- `subagent-heartbeat-goal-derived-state`: covered by `goal-scoped-subagent-details.ts` for required submitted state and passive-goal behavior; add a separate scenario only if needs-revision/accepted/blocking visual buckets need dedicated desktop proof.
- `subagent-heartbeat-stale`: proves stale or timed-out children are surfaced with the correct required/optional policy. Added in `tests/desktop-scenarios/subagent-heartbeat-stale.ts`.
- `subagent-bounded-worker-contract`: proves a coding child receives a structured brief, avoids repeated exploration after enough context, edits only the isolated copy-on-write worktree, validates with a real command exit status, submits a review packet instead of self-accepting, and hands off a recoverable diff for parent review. Added in `tests/desktop-scenarios/subagent-bounded-worker-contract.ts`.
- `subagent-review-revision-loop`: proves a parent/reviewer can reject a child submission with specific corrections, send those corrections back to the child, and later accept a revised submission. Added in `tests/desktop-scenarios/subagent-review-revision-loop.ts`.

Existing `subagent-handoff-parent-wake.ts` already proves explicit mailbox handoff wake behavior. Do not duplicate that scenario for the watcher unless the watcher is observing a non-message lifecycle event.

Each scenario should record runtime events, bootstrap/session evidence, visible renderer assertions, and screenshot/JSON artifacts. Prefer scripted OpenPond models and event waits over sleeps or live provider calls.

## Validation

- Delegation-policy evidence: 2026-07-09 pass added typed global and per-session delegation modes, new-session carryover plus existing-session PATCH persistence, parent-only system context injection, turn metadata diagnostics, Subagents Settings default selection, and the composer `SUB` menu. Passed `bun test tests/app-preferences.test.ts tests/session-store.test.ts tests/turn-runner-subagents.test.ts` (63 tests, 436 expects), `bun run typecheck`, `bun run build:contracts`, `bun run build:web`, and `git diff --check`.
- Current evidence: 2026-07-09 implementation pass updated the subagent contracts, native tool registry, runtime launch/finalization/review handling, structured packet-quality facts/evidence, explicit dismissal for blocked/failed/cancelled children, explicit parent/reviewer review decisions with child correction delivery, boundary review wake prompt packets, web runtime projection/activity labels and required lifecycle buckets, compact child final result summaries with retained-workspace expiry display, Subagents Settings copy, runtime-derived progress ledger derivation, repeated-exploration steering with role-configured thresholds, command exit-status preservation, copy-on-write dependency links, durable patch handoff artifacts, patch approval accept/decline/cancel/conflict retention behavior with 7-day retained-workspace metadata, automatic expired-retained-workspace cleanup through the lifecycle watcher and runner `retention_expired` policy, provider-failure handoff metadata, cleanup/archive/supersede/dismiss events, goal lifecycle coupling, child-session archive receipts, exposed `SubagentRun.updatedAt`, active/stale/scope store helpers, watcher diagnostics, dynamic watcher arming/disarming, optional stale attention, optional stale auto-cancel, orphan auto-cancel, scope-first watcher querying, required lifecycle wake policy, deterministic scripted lifecycle desktop models including parent review/revision and bounded-worker copy-on-write proofs, stable argument-derived scripted native tool-call ids, and a dedicated `subagent-lifecycle` queue so watcher ticks are not starved behind child execution.
- Retained-workspace expiry warning evidence: 2026-07-09 pass added the typed `subagent.workspace_retention_expiring` event, watcher-side 24-hour pre-cleanup warning emission, persisted warning metadata that does not bump `subagent_runs.updated_at`, warning-only diagnostics with `wakePolicy: "not_waking_parent_for_retained_workspace_expiry_warning"`, and retained-workspace warning scheduling that can replace a later cleanup timer with an earlier warning timer.
- Evidence retention evidence: 2026-07-09 pass added `SubagentEvidenceRetentionPolicySchema` and `SubagentRun.evidenceRetention` defaulting to indefinite parent-retained child messages and non-workspace artifact refs; cleanup/archive lifecycle records and child-session archive metadata now carry that policy separately from temporary workspace retention.
- Model allocation decision: stronger models should be prioritized for parent supervision/synthesis and boundary review, with specialist worker upgrades handled by existing role-level `modelRef` and subagent default model settings when budget/risk warrants it. No new runtime abstraction is needed beyond existing role model selection and reviewer-routing metadata.
- Fresh completion-audit proof: 2026-07-09 re-ran `bun run build:contracts`, `bun run typecheck`, `git diff --check`, `bun test tests/app-preferences.test.ts tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts tests/goal-details-subagents.test.tsx tests/server-http-route-table.test.ts tests/scripted-chat-provider.test.ts tests/server-work-queues.test.ts tests/chat-messages.test.ts` (185 tests, 1022 expects), and `bun run test:desktop:subagents` (12 scenarios; report `tmp/desktop-harness/subagent-suite/report.json`, generated `2026-07-09T07:33:32.504Z`, total 223502 ms).
- Passed: `bun run build:contracts`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts` (17 tests, 129 expects; includes `subagent.workspace_retention_expiring` contract parsing, warning/no-wake/dedupe behavior, warning-deadline scheduling with timer replacement, and metadata persistence without lifecycle timestamp churn).
- Passed: `bun test tests/subagent-contracts.test.ts tests/turn-runner-subagents.test.ts` (51 tests, 378 expects; includes evidence-retention schema defaults/validation and cleanup/archive metadata propagation).
- Passed: `bun test tests/app-preferences.test.ts tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts tests/goal-details-subagents.test.tsx tests/server-http-route-table.test.ts tests/scripted-chat-provider.test.ts tests/server-work-queues.test.ts tests/chat-messages.test.ts` (185 tests, 1022 expects; full focused subagent lifecycle unit suite, including preferences, contracts, store, watcher, runner, command/sandbox access, UI/runtime projections, scripted lifecycle provider, work queues, and chat projection).
- Passed: `bun run typecheck`.
- Passed: `git diff --check`.
- Phase 2.6 and packet-quality evidence: 2026-07-09 implementation pass added structured reviewer-routing metadata to `SubagentReviewState`, added `SubagentReviewPacketQualityEvidenceSchema`, added closed `SubagentReviewRoutingReasonSchema` reason codes, added role-level `SubagentReviewRoutingPolicySchema` for broad-edit thresholds and high-risk path regexes, derives advisory independent-review reasons from observed packet facts and role policy, renders packet-quality and routing evidence in watcher prompts, projects both through web runtime final results, and displays them in Goal details compact child results.
- Passed: `bun run build:contracts`.
- Passed: `bun test tests/app-preferences.test.ts` (6 tests, 43 expects; includes role review-routing and exploration-steering policy defaults, override normalization, invalid regex/threshold rejection, and legacy preference normalization).
- Passed: `bun test tests/subagent-contracts.test.ts tests/turn-runner-subagents.test.ts tests/subagent-lifecycle-watcher.test.ts tests/runtime-indexes.test.ts tests/goal-details-subagents.test.tsx` (72 tests, 511 expects; includes packet-quality evidence defaults/derivation, typed routing reason contract rejection, role-policy broad/high-risk routing derivation, role-policy exploration steering thresholds, weak-packet routing derivation, watcher prompt packet/routing evidence, runtime final-result projection, and Goal details display).
- Passed: `bun run typecheck`.
- Passed: `git diff --check`.
- Blocked-dismissal evidence: 2026-07-09 implementation pass allows `openpond_subagent_review` `decision: "dismiss"` for blocked required runs, keeps the run status blocked for audit history, marks `review.status = "dismissed"`, clears follow-up/blocker state, resolves goal completion gating without accepted-count inflation, and projects dismissed blocked runs as terminal/resolved in runtime state.
- Passed: `bun test tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/runtime-indexes.test.ts` (57 tests, 386 expects; includes blocked required child dismissal before goal completion, review-tool input mapping, and dismissed blocked runtime projection).
- Passed: `bun run typecheck`.
- Spec-only update: 2026-07-09 doc now records the child-owned stop-and-submit model, structural packet gates, goal-aware-not-goal-backed ownership boundary, and pending Phase 2.6 structured reviewer-routing metadata. Passed `git diff --check -- docs/subagent-lifecycle-working-notes.md`; no runtime tests were run for this documentation-only change.
- Passed: `bun test tests/runtime-indexes.test.ts tests/goal-details-subagents.test.tsx tests/subagent-lifecycle-watcher.test.ts tests/turn-runner-subagents.test.ts` (67 tests, 461 expects; includes watcher-enforced expired retained workspace cleanup without active runs, runner `retention_expired` cleanup removing a retained workspace instead of re-retaining it, and retained-workspace expiry display/projection).
- Passed: `bun test tests/subagent-lifecycle-watcher.test.ts tests/turn-runner-subagents.test.ts` (58 tests, 411 expects; focused watcher/runner retained-expiry cleanup proof).
- Passed: `bun run typecheck`.
- Passed: `bun test tests/runtime-indexes.test.ts tests/goal-details-subagents.test.tsx tests/turn-runner-subagents.test.ts` (54 tests, 381 expects; includes 7-day retained-workspace metadata on patch decline/cancel and retained cleanup records, web runtime derivation of workspace retention, and Goal details retained-workspace expiry display).
- Passed: `bun run typecheck`.
- Passed: `bun run test:desktop:subagents` (12 scenarios: heartbeat Settings, progress-only no-wake, thread-scoped watcher, stale policy, visible lifecycle, running state, handoff parent wake, watcher-submission wake, review/revision loop, bounded-worker contract, blocked approval, goal-scoped details; report `tmp/desktop-harness/subagent-suite/report.json`, generated 2026-07-09T05:30:55.447Z; total 239674 ms).
- Passed: `bun test tests/subagent-contracts.test.ts tests/turn-runner-subagents.test.ts tests/runtime-indexes.test.ts tests/capability-tool-registry.test.ts` (57 tests, 389 expects; includes dismissed review contract/event parsing, review-tool dismiss input, failed required child blocking before dismissal, goal completion after dismissal without accepted-count inflation, and web runtime resolved/not-blocking projection).
- Passed: `bun test tests/subagent-contracts.test.ts tests/turn-runner-subagents.test.ts tests/runtime-indexes.test.ts` (51 tests, 366 expects; includes packet-quality defaults, weak packet marking for missing requested validation, and compact result projection of packet-quality warnings).
- Passed: `bun test tests/turn-runner-subagents.test.ts` (43 tests, 319 expects; includes patch approval accept/apply/cleanup, decline/cancel retained-worktree behavior with explicit retained receipts, cancel lifecycle event naming, and apply-conflict pending/retry preservation).
- Passed: `bun scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-bounded-worker-contract.ts --isolated --timeout-ms 150000 --artifacts-dir tmp/desktop-harness/subagent-bounded-worker-contract --json tmp/desktop-harness/subagent-bounded-worker-contract/report.json` (focused desktop bounded-worker contract; asserted structured worker brief, copy-on-write child workspace, parent checkout unchanged, passed validation attempt, submitted-for-review/not accepted, and durable workspace handoff).
- Passed: `bun scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-review-revision-loop.ts --isolated --timeout-ms 180000 --artifacts-dir tmp/desktop-harness/subagent-review-revision-loop --json tmp/desktop-harness/subagent-review-revision-loop/report.json` (focused desktop review/revision loop; exactly two review decisions, exactly two submission receipts, final accepted state).
- Passed: `bun scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-heartbeat-no-progress-wake.ts --isolated --timeout-ms 150000 --artifacts-dir tmp/desktop-harness/subagent-heartbeat-no-progress-wake --json tmp/desktop-harness/subagent-heartbeat-no-progress-wake/report.json` (focused desktop progress-only no-wake scenario).
- Passed: `bun scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-heartbeat-thread-scoped.ts --isolated --timeout-ms 150000 --artifacts-dir tmp/desktop-harness/subagent-heartbeat-thread-scoped --json tmp/desktop-harness/subagent-heartbeat-thread-scoped/report.json` (focused desktop thread-scoped watcher scenario).
- Passed: `bun scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-heartbeat-stale.ts --isolated --timeout-ms 180000 --artifacts-dir tmp/desktop-harness/subagent-heartbeat-stale --json tmp/desktop-harness/subagent-heartbeat-stale/report.json` (focused desktop stale required/optional policy scenario).
- Passed: `bun test tests/server-work-queues.test.ts tests/chat-messages.test.ts tests/subagent-lifecycle-watcher.test.ts tests/scripted-chat-provider.test.ts` (67 tests, 355 expects; includes the separate watcher queue regression, stale chat activity projection, and scripted review/revision loop).
- Passed: `bun scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-heartbeat-settings.ts --isolated --timeout-ms 120000 --artifacts-dir tmp/desktop-harness/subagent-heartbeat-settings --json tmp/desktop-harness/subagent-heartbeat-settings/report.json` (focused desktop heartbeat Settings scenario).
- Passed: `bun test tests/app-preferences.test.ts` (6 tests, 37 expects).
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts tests/goal-details-subagents.test.tsx tests/server-http-route-table.test.ts tests/scripted-chat-provider.test.ts` (125 tests, 634 expects).
- Passed: `bun run typecheck`.
- Passed: `git diff --check`.
- Passed: `bun test tests/scripted-chat-provider.test.ts` (16 tests, 109 expects; includes scripted watcher-submission, sparse-context review/revision acceptance, bounded-worker command sequencing, stable duplicate-tool-call-id regression coverage, and generic lifecycle-watcher parent wakes without duplicate children).
- Passed: `bun scripts/desktop-harness.ts run tests/desktop-scenarios/subagent-watch-submission-wake.ts --isolated --timeout-ms 180000 --artifacts-dir tmp/desktop-harness/subagent-watch-submission-wake --json tmp/desktop-harness/subagent-watch-submission-wake/report.json` (focused desktop watcher-submission scenario).
- Passed: `bun test tests/runtime-indexes.test.ts tests/goal-details-subagents.test.tsx` (8 tests, 46 expects; includes compact child final result projection and rendering).
- Passed: `bun run typecheck`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts tests/goal-details-subagents.test.tsx tests/server-http-route-table.test.ts` (111 tests, 564 expects).
- Passed: `bun test tests/subagent-lifecycle-watcher.test.ts` (11 tests, 73 expects; includes orphaned active child auto-cancel for missing/archived parent sessions).
- Passed: `bun run typecheck`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts tests/goal-details-subagents.test.tsx tests/server-http-route-table.test.ts` (110 tests, 557 expects).
- Passed: `bun test tests/turn-runner-subagents.test.ts` (42 tests, 284 expects; includes watcher-driven parent wake after required child submission while parent is idle).
- Passed: `bun run typecheck`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts tests/goal-details-subagents.test.tsx tests/server-http-route-table.test.ts` (109 tests, 550 expects).
- Passed: `git diff --check`.
- Passed: `bun run build:contracts`.
- Passed: `bun test tests/app-preferences.test.ts`.
- Passed: `bun test tests/app-preferences.test.ts tests/subagent-contracts.test.ts tests/capability-tool-registry.test.ts tests/runtime-indexes.test.ts tests/turn-runner-subagents.test.ts`.
- Passed: `bun test tests/chat-messages.test.ts`.
- Passed: `bun test tests/app-models.test.ts tests/provider-model-options.test.ts`.
- Passed: `bun test tests/openpond-command-access.test.ts`.
- Passed: `bun test tests/sandbox-env-normalization.test.ts`.
- Passed: `bun test tests/openpond-direct-command.test.ts tests/model-tool-registry.test.ts`.
- Passed: `bun test tests/turn-runner-subagents.test.ts`.
- Passed: `bun test tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts tests/openpond-direct-command.test.ts tests/model-tool-registry.test.ts`.
- Passed: `bun run typecheck`.
- Passed: `bun test tests/capability-tool-registry.test.ts tests/model-tool-registry.test.ts`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts`.
- Passed: `bun test tests/subagent-store.test.ts tests/subagent-contracts.test.ts`.
- Passed: `bun test tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts`.
- Passed: `bun test tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts` (84 tests).
- Passed: `bun test tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts` (87 tests).
- Passed: `bun test tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts` (88 tests).
- Passed: `bun test tests/turn-runner-subagents.test.ts tests/runtime-indexes.test.ts` (42 tests).
- Passed: `bun run typecheck`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts` (100 tests, 447 expects; includes post-lifecycle `goal.subagents` snapshots).
- Passed: `bun run build:contracts`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/turn-runner-subagents.test.ts tests/runtime-indexes.test.ts` (44 tests, 285 expects; includes `subagent.archived` contract parsing and goal lifecycle child-session archive behavior).
- Passed: `bun run typecheck`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts` (100 tests, 457 expects; includes child-session archive receipts and metadata).
- Passed: `bun test tests/turn-runner-subagents.test.ts` (38 tests, 250 expects; includes sandbox-fork delete cleanup on explicit cancellation).
- Passed: `bun run typecheck`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts` (101 tests, 461 expects; includes sandbox-fork delete cleanup).
- Passed: `bun test tests/runtime-indexes.test.ts`.
- Passed: `bun test tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts` (93 tests).
- Passed: `bun test tests/subagent-contracts.test.ts tests/turn-runner-subagents.test.ts` (36 tests).
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts` (95 tests).
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts` (96 tests; includes dynamic watcher scheduling).
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts` (97 tests; includes optional stale attention receipts).
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts` (98 tests; includes parent/goal-scoped watcher querying).
- Passed: `bun test tests/turn-runner-subagents.test.ts` (36 tests; includes provider-failure recoverable handoff after validation and workspace mutation).
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts` (99 tests; includes provider-failure recoverable handoff).
- Passed: `bun test tests/subagent-lifecycle-watcher.test.ts tests/turn-runner-subagents.test.ts` (46 tests; includes boundary review prompt shape, child self-review rejection, and submitted-for-review goal-completion gate).
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts` (100 tests; includes Phase 2.5 boundary review prompt and child self-acceptance regressions).
- Passed: `git diff --check`.
- Passed: `bun test tests/runtime-indexes.test.ts tests/goal-details-subagents.test.tsx` (6 tests, 37 expects; includes Phase 8 watcher/latest-update/lifecycle bucket UI projection).
- Passed: `bun run typecheck`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts tests/goal-details-subagents.test.tsx` (102 tests, 470 expects; includes Phase 8 Goal details projection).
- Passed: `git diff --check`.
- Passed: `bun run build:contracts`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/turn-runner-subagents.test.ts` (40 tests, 263 expects; includes `subagent.workspace_retained` contract parsing and retained-workspace receipt emission).
- Passed: `bun run typecheck`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts tests/goal-details-subagents.test.tsx` (102 tests, 472 expects; includes workspace-retained operational event).
- Passed: `git diff --check`.
- Passed: `bun run build:contracts`.
- Passed: `bun run typecheck`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/turn-runner-subagents.test.ts tests/server-http-route-table.test.ts tests/goal-details-subagents.test.tsx` (44 tests, 312 expects; includes explicit cleanup/archive route, runner action, and Goal details controls).
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts tests/goal-details-subagents.test.tsx tests/server-http-route-table.test.ts` (105 tests, 512 expects; includes manual cleanup/archive controls).
- Passed: `git diff --check`.
- Passed: `bun run build:contracts`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/turn-runner-subagents.test.ts tests/goal-details-subagents.test.tsx` (49 tests, 316 expects; includes `superseded` contract parsing, goal restart superseding linked child runs, and UI/runtime resolved/terminal projection).
- Passed: `bun run typecheck`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts tests/goal-details-subagents.test.tsx tests/server-http-route-table.test.ts` (106 tests, 521 expects; includes `subagent.superseded` lifecycle coverage).
- Passed: `git diff --check`.
- Passed: `bun test tests/subagent-lifecycle-watcher.test.ts` (10 tests, 66 expects; includes optional stale auto-cancel after the grace threshold).
- Passed: `bun run typecheck`.
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts tests/goal-details-subagents.test.tsx tests/server-http-route-table.test.ts` (107 tests, 529 expects; includes optional stale auto-cancel policy).
- Passed: `git diff --check`.
- Passed: `bun test tests/turn-runner-subagents.test.ts` (41 tests, 270 expects; includes thread-scoped no-goal subagent execution).
- Passed: `bun test tests/subagent-contracts.test.ts tests/runtime-indexes.test.ts tests/subagent-lifecycle-watcher.test.ts tests/subagent-store.test.ts tests/turn-runner-subagents.test.ts tests/capability-tool-registry.test.ts tests/openpond-command-access.test.ts tests/sandbox-env-normalization.test.ts tests/goal-details-subagents.test.tsx tests/server-http-route-table.test.ts` (108 tests, 536 expects; includes thread-scoped no-goal subagent execution).
- Passed: `git diff --check`.
- Complete: no Phase 9 desktop lifecycle scenario remains open for this slice; full broad `bun test` cleanup remains separate from this focused lifecycle proof.
- Not run cleanly for this pass: full `bun test`. Accidental broad `bun test` was interrupted after unrelated failures in existing Get Started deck expectations, live server/orchestration tests, scaffold loop, and BYOK tool-order expectations; keep full-suite cleanup separate from this focused lifecycle slice.

## Open questions

- No open product questions remain for the current lifecycle spec slice. Full-suite cleanup remains tracked separately from this focused subagent lifecycle work.

## Opinionated recommendation

Use threads as the orchestrator and goals as the durable parent scope. Keep subagents as first-class workers, but make their lifecycle boring and dependable.

The best GPT-5.6-era direction for OpenPond is not more visible chat sprawl. It is thread-led, goal-scoped orchestration with bounded workers, structured handoffs, automatic cleanup, and clear audit trails.
