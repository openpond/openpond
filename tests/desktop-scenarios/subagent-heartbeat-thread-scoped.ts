import type { BootstrapPayload, RuntimeEvent, Session } from "@openpond/contracts";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import {
  asRecord,
  configureResearchSubagentModel,
  registerScriptedOpenPondModel,
  reloadRenderer,
  stringFromRecord,
  toolResultFromEvent,
  waitForAssistantOutput,
  waitForCompletedTurn,
  waitForRendererCondition,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "openpond-scripted-subagent-watch-submission",
};

export default desktopScenario({
  name: "subagent-heartbeat-thread-scoped",
  mode: "isolated",
  timeoutMs: 150_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);
    await configureResearchSubagentModel(harness, modelRef, { heartbeatIntervalSeconds: 10 });

    const title = harness.uniqueTitle("subagent-heartbeat-thread-scoped");
    const session = await harness.api.createSession<Session>({
      provider: "openpond",
      modelRef,
      title,
      cwd: harness.repoRoot,
    });

    await reloadRenderer(harness);
    harness.recordMetadata({
      parentSessionId: session.id,
      title,
      modelRef,
    });
    await harness.renderer.selectSession(session.id);
    await harness.renderer.assertText(title, { label: "thread-scoped parent session title" });

    await harness.api.createTurn(session.id, {
      prompt: "Start a thread-scoped child without an active goal and let the watcher surface submitted state.",
      modelRef,
    });

    const startEvent = await harness.events.waitForToolCompleted(
      session.id,
      "openpond_subagent_start",
    ) as RuntimeEvent;
    const startResult = toolResultFromEvent(startEvent);
    const runId = stringFromRecord(startResult, "runId");
    const childSessionId = stringFromRecord(startResult, "childSessionId");
    if (!runId) throw new Error("openpond_subagent_start did not return a runId.");
    if (!childSessionId) throw new Error("openpond_subagent_start did not return a childSessionId.");

    await waitForCompletedTurn(harness, session.id, startEvent, "thread-scoped initial parent turn completion");
    const submittedEvent = await harness.events.waitForSubagentSubmitted(session.id, runId) as RuntimeEvent;
    const submittedRun = asRecord(asRecord(submittedEvent.data)?.run);
    if (stringFromRecord(submittedRun, "parentSessionId") !== session.id) {
      throw new Error(`Submitted run parentSessionId did not match ${session.id}.`);
    }
    if (submittedRun?.parentGoalId !== null) {
      throw new Error(`Thread-scoped run unexpectedly had parentGoalId=${String(submittedRun?.parentGoalId)}.`);
    }
    harness.recordAssertion("threadScopedRunHasNoGoal", true);

    const wakeDiagnostic = await waitForThreadScopedWatcherWake(harness, session.id, runId);
    const assistantWake = await waitForAssistantOutput(
      harness,
      session.id,
      `Watcher lifecycle review wake received for ${runId}.`,
      "thread-scoped lifecycle wake assistant response",
    );
    await waitForCompletedTurn(harness, session.id, assistantWake, "thread-scoped lifecycle wake completion");

    await harness.renderer.selectSession(session.id, { timeoutMs: 10_000 });
    await harness.renderer.assertText("Subagent submitted", {
      label: "thread-scoped submitted activity visible",
    });
    await harness.renderer.assertText(`Watcher lifecycle review wake received for ${runId}.`, {
      label: "thread-scoped lifecycle wake visible",
    });
    harness.recordAssertion("threadScopedSubmittedActivityVisible", true);
    harness.recordAssertion("threadScopedParentWakeVisible", true);

    await openRightSidebarGoalDetails(harness);
    await harness.renderer.assertText("Goal Details", { label: "thread-scoped details title" });
    await harness.renderer.assertText("No active goal", { label: "thread-scoped no active goal state" });
    await harness.renderer.assertText("Subagents", { label: "thread-scoped subagent section" });
    await harness.renderer.assertText("Review submitted", { label: "thread-scoped review submitted row" });
    await harness.renderer.assertText("Required submitted", { label: "thread-scoped required submitted row" });
    harness.recordAssertion("threadScopedGoalDetailsSubagentsVisible", true);

    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    const childSession = bootstrap.sessions.find((item) => item.id === childSessionId);
    if (!childSession) throw new Error(`Child session ${childSessionId} was not present in bootstrap.`);
    if ((childSession.parentGoalId ?? null) !== null) {
      throw new Error(`Child session parentGoalId ${childSession.parentGoalId ?? "null"} was not null.`);
    }
    harness.recordMetadata({
      runId,
      childSessionId,
      parentTurnId: startEvent.turnId ?? null,
      wakeDiagnosticId: wakeDiagnostic.id ?? null,
      lifecycleWakeTurnId: assistantWake.turnId ?? null,
      runtimeEventCount: bootstrap.events.filter((event) => event.sessionId === session.id).length,
    });

    await harness.screenshot("subagent-heartbeat-thread-scoped-complete");
  },
});

async function waitForThreadScopedWatcherWake(
  harness: DesktopHarness,
  sessionId: string,
  runId: string,
): Promise<RuntimeEvent> {
  return await harness.events.waitFor(
    (event) => {
      if (event.sessionId !== sessionId || event.name !== "diagnostic") return false;
      const data = asRecord(event.data);
      const runIds = Array.isArray(data?.runIds) ? data.runIds : [];
      const reasons = Array.isArray(data?.reasons) ? data.reasons : [];
      return data?.kind === "subagent_lifecycle_watcher_wake" &&
        data.wakeQueued === true &&
        data.parentGoalId === null &&
        stringFromRecord(data, "wakeQueuedParentSessionId") === sessionId &&
        runIds.includes(runId) &&
        reasons.includes("required_submitted_for_review");
    },
    `thread-scoped watcher wake:${runId}`,
    { sessionId },
  ) as RuntimeEvent;
}

async function openRightSidebarGoalDetails(harness: DesktopHarness): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const showSidebar = buttons.find((button) =>
        button.getAttribute('aria-label')?.startsWith('Show changes sidebar')
      );
      if (showSidebar instanceof HTMLButtonElement) showSidebar.click();
      return Boolean(
        document.querySelector('[aria-label="Workspace diffs"]') ||
        document.querySelector('[aria-label="Right sidebar"]') ||
        document.querySelector('button[role="tab"]')
      );
    })()`,
    "right sidebar open",
    { timeoutMs: 10_000 },
  );
  await waitForRendererCondition(
    harness,
    `(() => {
      const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
      const goalTab = tabs.find((tab) => tab.textContent?.trim() === 'Goal');
      if (!(goalTab instanceof HTMLButtonElement)) return false;
      if (goalTab.getAttribute('aria-selected') !== 'true') goalTab.click();
      return goalTab.getAttribute('aria-selected') === 'true';
    })()`,
    "right sidebar goal tab",
    { timeoutMs: 10_000 },
  );
}
