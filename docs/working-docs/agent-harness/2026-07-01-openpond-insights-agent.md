# OpenPond Insights Agent

**Status:** Superseded; implementation removed

**Date:** 2026-07-01

**Owner:** OpenPond App / Agent Harness

## Latest checkpoint

**2026-07-27:** The Insights agent, background scans, observations, questions, routes, settings, storage, usage attribution, and UI have been removed. Lab AI Suggestions continue through the separate Task Miner candidate system. The content below is retained only as implementation history; [Remove OpenPond Goals and Insights, Preserve Codex Goals](2026-07-27-openpond-goal-insights-removal.md) is authoritative.

## Correction

The previous version of this working doc was wrong for the intended architecture.

It described Insights as a rule-only background scanner and explicitly excluded:

- model-backed analysis
- hidden/system insight conversations
- goal attachment or goal mutation

That contradicts the product direction: Insights should be a first-class automated agent built on the same goal/conversation loop infrastructure as create/edit. The rule-based scanner is useful, but only as the telemetry/evidence layer that feeds the Insights goal loop.

## Recovery Plan

The current implementation should not be reverted wholesale. It should be reclassified.

Current scanner implementation becomes:

- evidence collection
- low-cost dedupe/cursor plumbing
- initial insight row storage
- basic Insights page and topbar surfaces

It is not the finished Insights agent.

The recovery work is to add the missing goal/conversation layer underneath the existing surfaces:

1. Persist Insights runs.
2. Create/tag/hide Inspectable Insights system sessions.
3. Run Insights through the same goal-backed conversation loop used by other agents.
4. Link every row to both source evidence and the run that produced it.
5. Show the run history and transcript entrypoints from the Insights page.

Do not add more scanner-only behavior and call it done. Every new scan/run feature should answer:

- Which Insights run produced this?
- Where is the run transcript?
- What source chat/turn/pipeline was inspected?
- Which goal status was active during the run?

## Goal

Build Insights as a real OpenPond goal-backed agent loop.

Insights should:

- run in the background while the app is open
- use the existing conversation/thread and goal runtime model
- create durable, inspectable run threads
- read compact telemetry/evidence from create/edit activity
- produce/update insight rows that are visible in the Insights page and top-row indicator
- support `/insights` as a command path into the same system

The core requirement is not just "scan and write rows." The core requirement is:

```text
scheduled evidence scan -> goal-backed Insights run thread -> model/rules produce findings -> insight rows update -> user can inspect source and run transcript
```

## Product Shape

Insights is a built-in OpenPond system agent.

```text
id: openpond.insights
source: builtin
mode: automated-goal-agent
surfaces: background loop, /insights, left-sidebar Insights page, top-row indicator
scope: global local app
profile: builtin system agent, not user profile managed
```

Use a built-in `Insights` system project/folder as the UI grouping model:

- It groups Insights system session(s) and run turns using familiar local-project/sidebar behavior.
- It is not a normal user-created workspace project.
- It is hidden from Local Projects by default.
- The project row overflow menu includes `Hide from Local Projects` / `Show in Local Projects`.
- The Insights page remains the primary surface even if the system project is hidden.

This keeps the UI simple: users can inspect the underlying conversation through a recognizable project/thread path without polluting the normal chat list by default.

## Conversation And Goal Model

Each Insights execution should have a durable conversation/thread.

Minimum model:

- create or reuse a global Insights system project/folder
- create or reuse an Insights system session/thread under that project/folder
- tag it as `openpond.insights`
- attach a goal objective for the run
- write runtime events for goal lifecycle and scan activity
- store run metadata that links the run to produced insight rows

The run thread must be inspectable.

Expected UI access:

- Insights page has a `Runs` section or tab.
- Each run row shows status, trigger, started/completed time, model, and number of findings.
- `Open run` opens the underlying conversation transcript.
- Each insight row can link to:
  - `Open source` for the source create/edit chat/session/turn/pipeline.
  - `Open run` for the Insights agent run that produced or last updated the row.

Do not rely only on hidden database rows. If the agent reasoned about something, the user must have a path to inspect that run.

## Model Selection

Do not hardcode a model.

Insights should use the app/provider model selection path:

- default to the current app automation/default model setting
- allow an Insights-specific model setting
- record the provider/model used on each run

If no usable model is configured, the background loop should not silently fail. It should create a visible run/insight status explaining that Insights needs a model configuration.

## Evidence Input

The current create/edit detector is still useful, but it is evidence, not the whole product.

Evidence sources:

- `create_pipeline.updated`
- source session id
- source turn id
- create pipeline id/state/operation
- source event sequence
- compact title/summary from the create/edit state

Insight cases:

- create/edit flow is awaiting questions
- create/edit flow is awaiting plan approval
- create/edit flow is blocked
- create/edit flow failed

## Run Scheduling

Insights has one goal-backed run loop.

That loop has a cheap evidence collection stage before model execution:

1. collect compact app/conversation evidence
2. compare the latest source cursor and evidence hash
3. skip if nothing changed and the trigger does not require a fresh run
4. create one turn in the global Insights system session when execution is needed
5. summarize/analyze the evidence and apply validated structured insight actions

The evidence collection stage can run frequently and must stay async, but it is not a separate scanner-only product. It is input plumbing for the same Insights goal loop.

The runner should execute when there is meaningful new evidence:

- startup scan after local server is ready
- interval scan, about 5 minutes
- manual scan from the Insights page
- `/insights` command

The runner must dedupe input with a stable evidence cursor/hash so it does not keep starting identical goal turns.

Minimum cursor metadata:

- latest source runtime event sequence consumed
- evidence hash for the compact evidence bundle
- run trigger: `startup`, `interval`, `manual`, or `slash_command`
- global Insights scope plus source session reference when applicable

## Data Model

The goal/thread should be the source of truth for an Insights run.

Do not duplicate full goal state, transcript text, or model reasoning in an Insights-specific table.

Keep `insight_items` as the output table, but it is not enough by itself.

Keep/extend:

```sql
insight_items
```

Do not add `insight_runs` for the target implementation.

Run history comes from the global Insights system session:

- each scan is a turn in the Insights system session
- each scan turn has goal runtime events
- each scan turn stores compact run metadata in turn metadata and/or runtime events
- the Insights page lists runs by querying that system session's turns/runtime events

Add explicit fields to tag sessions as system/Insights sessions:

- `systemKind: "openpond.insights" | null`
- `hiddenFromDefaultSidebar: boolean`

This is required so Insights run threads can be hidden from normal chat lists while still inspectable from the Insights page.

Add explicit fields to tag the system project/folder:

- `systemKind: "openpond.insights"`
- `hiddenFromDefaultSidebar: boolean`

The system project/folder must be distinguishable from user-created local projects.

Insight rows should link back to runs:

- `lastRunId`
- source goal/run id when available
- source `sessionId`
- source `turnId`
- Insights run session id
- Insights run turn id
- source create pipeline id/state
- source event sequence

Canonical run data is read from the Insights system session/thread and its goal/runtime events.

## UI

### Insights Page

The Insights page is the home for this system.

It should show:

- filter row
- active scan/run status
- insight rows
- run history

For each insight:

- severity
- status
- title
- summary
- source reference
- last updated
- actions: resolve, dismiss, reopen
- action: open source
- action: open run

For each run:

- status: queued, running, completed, failed
- trigger
- started/completed time
- model
- input evidence summary
- output summary
- row count changes
- action: open run thread

### Top Row Indicator

The top-row lightbulb should:

- show active insight count
- show a hover dropdown of active insights
- open the Insights page on click
- indicate active Insights run state

### Slash Command

`/insights` should use the same system, not a separate implementation.

Minimum behavior:

- `/insights` opens the Insights page and triggers a run if evidence changed
- `/insights <question>` should become an interactive query against the Insights run/thread history

`/insights <question>` is part of the completed system. It should query the Insights run/thread history, not return a detached rule summary.

## Target Decisions

These decisions define the target implementation:

- **Goal/run source of truth:** the global Insights system session, its turns, and its goal/runtime events.
- **Loop model:** one long-lived Insights goal loop; evidence collection is a stage in that loop, not a second product loop.
- **Run indexing:** no `insight_runs` table in the target implementation.
- **Scope:** global to the local app.
- **UI grouping:** built-in Insights system project/folder, hidden from Local Projects by default or hideable through the row overflow menu.
- **Session shape:** one long-lived global Insights system session, with each scan as a goal/turn.
- **Session/project hiding/tagging:** add explicit typed fields for `systemKind: "openpond.insights"` and `hiddenFromDefaultSidebar`.
- **Model setting:** use the configured app automation/default model, with an Insights-specific setting available in settings.
- **Output protocol:** model output should update insight rows through a structured tool/schema; do not rely on free-form text parsing for row updates.
- **Cost control:** start a model-backed run only when the compact evidence hash/cursor changes or the user explicitly requests a scan/question.
- **Transcript access:** `Open run` opens the normal transcript UI for the tagged Insights session/turn.
- **Question mode:** `/insights <question>` queries the Insights run history plus linked source evidence.
- **Architecture reference:** use Create/Edit workflow patterns for extending goals: structured evidence/state plus goal-backed conversation execution, not detached background-only logic.

## Implementation Phases

### Phase 1 - End-To-End Goal-Backed Insights Loop

Phase 1 is the actual corrected feature, not a foundation-only pass. It must produce one real goal-backed Insights loop that a user can inspect.

System identity and storage:

- [x] Add `systemKind: "openpond.insights" | null` to local project/folder records.
- [x] Add `hiddenFromDefaultSidebar: boolean` to local project/folder records.
- [x] Add `systemKind: "openpond.insights" | null` to sessions.
- [x] Add `hiddenFromDefaultSidebar: boolean` to sessions.
- [x] Add `lastRunSessionId` and `lastRunTurnId` to `insight_items`.
- [x] Keep existing source evidence references for source session, source turn, pipeline, and source event sequence.
- [x] Do not add `insight_runs`.
- [x] Add an idempotent server helper: `ensureInsightsSystemProject()`.
- [x] Add an idempotent server helper: `ensureInsightsSystemSession()`.
- [x] The project is global to the local app and tagged `openpond.insights`.
- [x] The session is one long-lived global Insights system session under that project/folder.
- [x] The project and session are hidden from default sidebar lists unless explicitly shown.

Runner flow:

- [x] Background interval, startup, manual scan, and `/insights` all call the same runner entrypoint.
- [x] The runner creates/reuses the global Insights system project/session before doing work.
- [x] The runner collects compact evidence from the create/edit detector.
- [x] The runner computes a stable evidence hash and source cursor.
- [x] The runner skips model-backed execution when the evidence hash/cursor has not changed, unless the trigger is manual or `/insights <question>`.
- [x] The runner creates a new turn in the global Insights system session for every executed run.
- [x] Store trigger, evidence hash, source cursor, provider/model, row counts, and error summary in turn metadata and/or runtime events.
- [x] Store explicit elapsed-time and usage summaries in run metadata when usage events are available.

Goal lifecycle:

- [x] Each run turn starts with a clear goal objective, for example: "Review recent OpenPond create/edit agent flow health and update actionable Insights rows."
- [x] Write `thread_goal` runtime events for active/completed/failed goal state.
- [x] Record provider/model, completion status, and token/context usage through the run turn and its runtime events when available.
- [x] If no model is configured or provider execution cannot start, create a failed/blocked run turn with an explicit configuration message instead of silently doing nothing.
- [x] Mark the run turn completed, failed, or interrupted using the normal session/turn lifecycle.

Evidence bundle:

- [x] Evidence is compact and structured.
- [x] Include source session id, turn id, pipeline id/state/operation, source event sequence, and current insight row state for matching fingerprints.
- [x] Do not send full conversation history by default.
- [x] Include links/ids so the output can point back to source evidence.
- [x] Preserve the current create/edit detector as the first evidence generator.

Model execution and structured output:

- [x] Route through configured provider/model settings.
- [x] Do not hardcode model ids.
- [x] Use the same goal/conversation execution patterns as Create/Edit.
- [x] Keep model execution async through the background queue so chat submit, streaming, tools, and startup remain unblocked.
- [x] Use a structured action schema for row writes; do not write rows from free-form text parsing.
- [x] Supported actions: create insight, update insight, resolve insight, dismiss/no-op, add run summary.
- [x] Every created/updated insight must include severity, title, summary, fingerprint, source evidence ids, run session id, and run turn id.
- [x] Validate structured output before writing rows.
- [x] Accept provider/tool-schema structured output from the run turn when available, with validated rule-produced structured actions as the fallback path.
- [x] On invalid output, mark the run failed and preserve the transcript for inspection.

Row updates:

- [x] Upsert insight rows by stable fingerprint.
- [x] Link updated rows to `lastRunSessionId` and `lastRunTurnId`.
- [x] Resolve stale active rows only when the run explicitly determines they are no longer active.
- [x] Preserve user-dismissed rows unless the model has strong new evidence and records why it reopened them.

Run history and navigation:

- [x] Add helper queries that list Insights runs by reading the Insights system session turns/runtime events.
- [x] Expose those runs through the Insights API.
- [x] Add run history to the Insights page.
- [x] Add `Open run` to each run.
- [x] Add `Open run` and `Open source` to insight rows.
- [x] `Open run` opens the real transcript/runtime events for the tagged Insights session turn, not a synthetic summary.
- [x] Keep Insights system sessions hidden from the default chat list unless the user opens them from Insights or shows the system project.

UI and commands:

- [x] Add project row overflow actions: `Hide from Local Projects` and `Show in Local Projects`.
- [x] Keep the Insights system project hidden from Local Projects by default.
- [x] The Insights page shows filter row, active run status, insight rows, and run history.
- [x] The topbar/page scan status reflects the goal-backed run, not only the cheap scanner.
- [x] `/insights` triggers/opens the same goal-backed system.
- [x] `/insights <question>` queries the Insights run history plus linked source evidence.

Tests:

- [x] Creating the system project/session is idempotent.
- [x] Hidden system projects/sessions do not appear in default sidebar lists.
- [x] The system project can be shown again through the hide/show field.
- [x] Insight rows link to an Insights run session id and turn id.
- [x] Insights run list is derived from the system session turns/runtime events.
- [x] Manual scan creates a real Insights run turn.
- [x] Background scan creates a real Insights run turn when evidence changes.
- [x] Unchanged evidence skips model-backed execution unless manually requested.
- [x] Missing model configuration creates an inspectable failed/blocked run.
- [x] Structured output updates insight rows and preserves source/run links.

### Phase 2 - Broader Evidence And Tuning

Phase 2 expands the completed Phase 1 loop. It should not change the architecture or add a second run system.

- [x] Add additional evidence generators for stuck turns, repeated tool failures, abandoned goals, repeated user corrections, and long-running unresolved conversations.
- [x] Add per-evidence-source enablement controls if the signal gets noisy.
- [x] Add richer run filtering by trigger, model, status, and source evidence type.
- [x] Add tests for additional evidence generators and richer filtering.

## Current Implementation Status

Implemented in the current branch:

- hidden/tagged global Insights system project and session
- one long-lived Insights system session with each executed scan represented as a turn
- no `insight_runs` table; run history is derived from the Insights session turns/runtime events
- `insight_items` storage with source evidence fields and last-run links
- create/edit evidence detector
- stable source cursor/evidence hash dedupe
- startup, interval, manual scan, and slash-command paths routed through the same service
- model selection through default app settings plus an Insights-specific model override
- `/insights` opens/triggers the Insights system
- `/insights <question>` asks against the Insights run history plus linked evidence
- left-sidebar Insights page with filters, active scan status, insight rows, source/run links, and run history
- top-row lightbulb indicator with active count, hover dropdown, click-through navigation, and scan status
- hidden system project/session behavior with hide/show control for the system project
- structured action validation before writing insight rows
- provider/tool-schema structured output can be accepted from run turn metadata, with validated rule-produced structured actions as the fallback path
- explicit elapsed-time and token/context-usage summaries on run metadata when usage events are available
- failed provider/model configuration paths become inspectable failed Insights run turns
- invalid structured output marks the run failed without writing rows
- dismissed insight rows are preserved across later scans
- broader evidence generators for stuck/failed turns, repeated tool failures, abandoned goals, repeated user corrections, and long-running unresolved conversations
- per-evidence-source enablement settings
- Insights page source/run filters and server-side run filters by trigger, status, model, and source
- focused tests for the goal-backed run loop, settings, question mode, sidebar hiding, detector behavior, route table, and composer slash behavior

Open implementation details:

- none for this working spec

The current implementation should be treated as the completed goal-backed Insights loop for this working spec.

## Done Criteria

Insights is not done until all of these are true:

- A background or manual Insights execution creates a turn in the global Insights system session.
- That run is linked to a real tagged Insights session/thread.
- The run is grouped under the global Insights system project/folder.
- The run has a goal objective and goal runtime events.
- The Insights page can show that run in history.
- The user can open the run transcript from the Insights page.
- Insight rows link to the run that produced them.
- Insight rows link back to the source chat/session/turn/pipeline where available.
- The default sidebar does not get spammed by automated Insights sessions.
- The topbar/page scan status reflects the goal-backed run, not only the cheap scanner.
