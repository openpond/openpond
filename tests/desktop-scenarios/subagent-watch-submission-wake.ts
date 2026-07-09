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
  name: "subagent-watch-submission-wake",
  mode: "isolated",
  timeoutMs: 150_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);
    await configureResearchSubagentModel(harness, modelRef, { heartbeatIntervalSeconds: 10 });

    const title = harness.uniqueTitle("subagent-watch-submission-wake");
    const goal = {
      id: `goal_${Date.now().toString(36)}`,
      provider: "openpond",
      objective: "Prove watcher-driven child submission review wake.",
      status: "running",
      timeUsedSeconds: 12,
      tokensUsed: 512,
      tokenBudget: 4096,
    };
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
      goalId: goal.id,
    });
    await harness.renderer.selectSession(session.id);
    await harness.renderer.assertText(title, { label: "watch submission parent session title" });

    await harness.api.createTurn(session.id, {
      prompt: "Start a child that will submit and let the watcher wake this parent chat.",
      modelRef,
      metadata: { threadGoal: goal },
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

    await waitForCompletedTurn(harness, session.id, startEvent, "initial watcher parent turn completion");
    await harness.renderer.assertText(`Research subagent submitted for watcher review for ${runId}.`, {
      label: "initial parent turn idled after start",
    });
    harness.recordAssertion("initialParentTurnIdledAfterStart", true);

    const submittedEvent = await waitForSubagentSubmitted(harness, session.id, runId);
    const submittedRun = asRecord(asRecord(submittedEvent.data)?.run);
    if (stringFromRecord(submittedRun, "parentGoalId") !== goal.id) {
      throw new Error(`Submitted run parentGoalId did not match ${goal.id}.`);
    }

    const wakeDiagnostic = await waitForWatcherWakeQueued(harness, session.id, runId);
    const assistantWake = await waitForAssistantOutput(
      harness,
      session.id,
      `Watcher lifecycle review wake received for ${runId}.`,
      "watcher lifecycle wake assistant response",
    );
    if (assistantWake.turnId === startEvent.turnId) {
      throw new Error("Expected watcher lifecycle wake response to run in a queued parent turn.");
    }
    await waitForCompletedTurn(harness, session.id, assistantWake, "queued watcher parent wake turn completion");

    await harness.renderer.selectSession(session.id, { timeoutMs: 10_000 });
    await harness.renderer.assertText(`Watcher lifecycle review wake received for ${runId}.`, {
      label: "queued watcher wake response visible",
    });
    await harness.renderer.assertText("Subagent submitted", {
      label: "submitted activity visible",
      timeoutMs: 10_000,
    });
    harness.recordAssertion("watcherWakeResponseVisible", true);
    harness.recordAssertion("submittedActivityVisible", true);

    await openRightSidebarGoalDetails(harness);
    await harness.renderer.assertText("Goal Details", { label: "right sidebar goal details title" });
    await harness.renderer.assertText("Child Results", { label: "child results section visible" });
    await harness.renderer.assertText("Research subagent submitted the scripted watcher review packet.", {
      label: "child result summary visible",
    });
    await harness.renderer.assertText("Required submitted", { label: "required submitted count row visible" });
    harness.recordAssertion("childResultsVisible", true);
    harness.recordAssertion("requiredSubmittedCountVisible", true);

    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    const parentStartEvents = bootstrap.events.filter((event) =>
      event.sessionId === session.id &&
      event.name === "tool.completed" &&
      event.action === "openpond_subagent_start"
    );
    const watcherWakeEvents = bootstrap.events.filter((event) =>
      event.sessionId === session.id &&
      event.name === "diagnostic" &&
      asRecord(event.data)?.kind === "subagent_lifecycle_watcher_wake" &&
      asRecord(event.data)?.wakeQueued === true
    );
    const lifecycleWakeAssistantEvents = bootstrap.events.filter((event) =>
      event.sessionId === session.id &&
      event.name === "assistant.delta" &&
      event.output?.includes(`Watcher lifecycle review wake received for ${runId}.`)
    );
    if (parentStartEvents.length !== 1) {
      throw new Error(`Expected exactly one parent subagent start event, found ${parentStartEvents.length}.`);
    }
    if (watcherWakeEvents.length !== 1) {
      throw new Error(`Expected exactly one watcher wake diagnostic, found ${watcherWakeEvents.length}.`);
    }
    if (lifecycleWakeAssistantEvents.length !== 1) {
      throw new Error(`Expected exactly one lifecycle wake assistant response, found ${lifecycleWakeAssistantEvents.length}.`);
    }

    harness.recordAssertion("singleParentSubagentStart", true);
    harness.recordAssertion("singleWatcherWakeDiagnostic", true);
    harness.recordAssertion("singleLifecycleWakeAssistantResponse", true);
    harness.recordMetadata({
      runId,
      childSessionId,
      parentTurnId: startEvent.turnId ?? null,
      wakeDiagnosticId: wakeDiagnostic.id ?? null,
      lifecycleWakeTurnId: assistantWake.turnId ?? null,
      runtimeEventCount: bootstrap.events.filter((event) => event.sessionId === session.id).length,
    });

    await harness.screenshot("subagent-watch-submission-wake-complete");
  },
});

async function waitForSubagentSubmitted(
  harness: DesktopHarness,
  sessionId: string,
  runId: string,
): Promise<RuntimeEvent> {
  return await harness.events.waitFor(
    (event) =>
      event.sessionId === sessionId &&
      event.name === "subagent.submitted" &&
      asRecord(event.data)?.run &&
      stringFromRecord(asRecord(asRecord(event.data)?.run), "id") === runId &&
      stringFromRecord(asRecord(asRecord(event.data)?.run), "status") === "submitted_for_review",
    `subagent.submitted:${runId}`,
    { sessionId },
  ) as RuntimeEvent;
}

async function waitForWatcherWakeQueued(
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
        stringFromRecord(data, "wakeQueuedParentSessionId") === sessionId &&
        runIds.includes(runId) &&
        reasons.includes("required_submitted_for_review");
    },
    `subagent lifecycle watcher wake:${runId}`,
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
