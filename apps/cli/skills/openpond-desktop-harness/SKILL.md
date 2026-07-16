---
name: openpond-desktop-harness
description: Author, run, debug, or extend OpenPond verifiable desktop harness scenarios for the Electron desktop app, multi-turn chat, runtime events, renderer UX, subagent lifecycle/running/handoff/blocker behavior, scripted provider models, or JSON/screenshot proof. Use when Codex is asked to add desktop harness coverage, validate UI/UX behavior through the harness, update tests under tests/desktop-scenarios, or use openpond harness desktop run.
---

# OpenPond Desktop Harness

## Overview

Use the desktop harness to prove real OpenPond desktop behavior with runtime events, bootstrap/store state, CDP-rendered UI assertions, and screenshot/JSON artifacts. Prefer typed server setup and event waits over blind pointer automation, but use visible renderer actions for UX-critical flows.

## First Files To Read

- `docs/working-docs/agent-harness/2026-07-08-verifiable-desktop-harness.md`: current phased plan, status, evidence, and boundaries.
- `tests/desktop-scenarios/README.md`: implemented scenario list, artifact convention, and useful commands.
- `scripts/desktop-harness/types.ts`: scenario and harness API contract.
- `tests/desktop-scenarios/helpers.ts`: shared scripted model setup, subagent preference setup, event parsing, renderer waits, and sidebar helpers.
- One nearby scenario in `tests/desktop-scenarios/*.ts` that matches the behavior being added.

## Workflow

1. Inspect existing harness code before editing. Reuse `harness.api`, `harness.events`, `harness.renderer`, and helpers instead of adding one-off polling or DOM code in scenarios.
2. Decide what the scenario proves:
   - Use server APIs for setup-heavy state such as sessions, preferences, provider overrides, long histories, or fixture workspaces.
   - Use visible renderer actions for UX behavior such as composer submission, session selection, child row expansion, right-sidebar interaction, and rendered receipts.
   - Use runtime/bootstrap assertions for correctness: event names, turn ids, run ids, parent/child linkage, pending approvals, blocked/completed states, and persisted sessions.
3. If provider decisions must be deterministic, use the development-only OpenPond scripted models gated by `OPENPOND_HARNESS_SCRIPTED_MODELS=1`; isolated harness launch enables this gate.
4. Add or update a scenario under `tests/desktop-scenarios/` with `desktopScenario({ name, mode, timeoutMs, run })`.
5. Record durable proof with `harness.recordAssertion`, `harness.recordMetadata`, and `await harness.screenshot(...)`.
6. Run focused unit tests first, then the scenario in isolated desktop mode, and update the working doc validation/progress sections with exact commands. Use packaged mode only when a packaged app artifact already exists.

## Scenario Pattern

```ts
import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import {
  registerScriptedOpenPondModel,
  reloadRenderer,
  waitForCompletedTurn,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "openpond-scripted-chat-two-turns",
};

export default desktopScenario({
  name: "my-desktop-proof",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);
    const session = await harness.api.createSession({
      provider: "openpond",
      modelRef,
      title: harness.uniqueTitle("my-desktop-proof"),
      cwd: harness.repoRoot,
    });

    await reloadRenderer(harness);
    await harness.renderer.selectSession(session.id);
    await harness.renderer.submitComposer("Exercise the behavior through the real composer.");

    const start = await harness.events.waitForName(session.id, "turn.started");
    await waitForCompletedTurn(harness, session.id, start, "turn completion");
    await harness.renderer.assertText("expected visible response");

    harness.recordAssertion("expectedResponseVisible", true);
    harness.recordMetadata({ parentSessionId: session.id });
    await harness.screenshot("my-desktop-proof-complete");
  },
});
```

## Commands

Use the script runner during harness development:

```bash
pnpm exec vitest run tests/desktop-harness-runner.test.ts tests/scripted-chat-provider.test.ts
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/chat-two-turns.ts --isolated --timeout-ms 120000 --artifacts-dir tmp/desktop-harness/chat-two-turns --json tmp/desktop-harness/chat-two-turns/report.json
pnpm exec tsx scripts/desktop-harness.ts run tests/desktop-scenarios/chat-two-turns.ts tests/desktop-scenarios/subagent-visible-lifecycle.ts tests/desktop-scenarios/subagent-running-state.ts tests/desktop-scenarios/subagent-handoff-parent-wake.ts tests/desktop-scenarios/subagent-blocked-approval.ts tests/desktop-scenarios/goal-scoped-subagent-details.ts tests/desktop-scenarios/context-compaction-followup.ts --isolated --timeout-ms 150000 --artifacts-dir tmp/desktop-harness/desktop-scenarios --json tmp/desktop-harness/desktop-scenarios/report.json
pnpm exec tsx scripts/desktop-harness-report.ts summarize tmp/desktop-harness/desktop-scenarios/report.json --json tmp/desktop-harness/release-proof/summary.json --markdown tmp/desktop-harness/release-proof/summary.md
```

Use the CLI wrapper when validating the installed/source CLI entrypoint:

```bash
pnpm --dir apps/cli cli harness desktop run tests/fixtures/desktop-harness/pass-scenario.ts --none --artifacts-dir tmp/desktop-harness/cli-wrapper --json tmp/desktop-harness/cli-wrapper/report.json
openpond harness desktop run tests/desktop-scenarios/chat-two-turns.ts --isolated --json tmp/desktop-harness/chat-two-turns/report.json
openpond harness desktop attach tests/desktop-scenarios/chat-two-turns.ts --server http://127.0.0.1:17874 --devtools-port 9333 --token-file tmp/token
openpond harness desktop run tests/desktop-scenarios/chat-two-turns.ts --packaged --app release/linux-unpacked/openpond --json tmp/desktop-harness/packaged-chat/report.json
```

## Proof Rules

- Every product-behavior scenario should assert runtime evidence and rendered UI evidence.
- Prefer `harness.events.waitFor*` for runtime state, not fixed sleeps.
- Prefer visible text, ARIA labels, and stable product semantics for renderer assertions. Add `data-testid` only after semantic selectors are inadequate.
- Keep screenshots and JSON reports under `tmp/desktop-harness/<purpose>/`.
- Do not put secrets, cookies, OAuth tokens, raw `.env` values, provider keys, or storage state in logs, metadata, screenshots, reports, or docs.
- Do not make live provider calls part of default correctness proof. Add live-provider variants only as opt-in proof.
- Do not bypass the real turn runner, event bus, store, bootstrap projection, or renderer when a scenario claims desktop product behavior proof.

## Common Scenario Targets

- Multi-turn chat: visible composer submit, assistant deltas, completed turns, persisted bootstrap session.
- Subagent lifecycle: `openpond_subagent_start`, `join`, `subagent.completed`, parent receipt, child sidebar grouping, child conversation text.
- Running state: delayed child execution, parent activity running row, sidebar running indicator, final completion.
- Handoff: child `openpond_subagent_send_message`, parent wake metadata, one child start, no duplicate child run.
- Blocker/approval: blocked runtime event and visible blocked UI, no accidental completion, no unexpected pending approval.
- Goal-scoped subagents: active Goal strip, right-sidebar Goal details, subagent counts, child `parentGoalId`.
- Context compaction: manual compaction status divider, summary event metadata, usage record, and post-compaction follow-up turn.
