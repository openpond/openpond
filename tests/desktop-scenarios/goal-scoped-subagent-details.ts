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
  waitForCompletedTurn,
  waitForRendererCondition,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "openpond-scripted-goal-subagent-running",
};

export default desktopScenario({
  name: "goal-scoped-subagent-details",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);
    await configureResearchSubagentModel(harness, modelRef);

    const title = harness.uniqueTitle("goal-scoped-subagent-details");
    const goal = {
      id: `goal_${Date.now().toString(36)}`,
      provider: "openpond",
      objective: "Coordinate the goal-scoped desktop subagent proof.",
      status: "running",
      timeUsedSeconds: 73,
      tokensUsed: 2048,
      tokenBudget: 8192,
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
      goalObjective: goal.objective,
    });
    await harness.renderer.selectSession(session.id);
    await harness.renderer.assertText(title, { label: "goal-scoped parent session title" });

    await harness.api.createTurn(session.id, {
      prompt: "Start the scripted research subagent while the goal runtime stays visible.",
      modelRef,
      metadata: { threadGoal: goal },
    });

    await waitForGoalRuntimeEvent(harness, session.id, goal.id);
    const startEvent = await harness.events.waitForToolCompleted(
      session.id,
      "openpond_subagent_start",
    ) as RuntimeEvent;
    const startResult = toolResultFromEvent(startEvent);
    const runId = stringFromRecord(startResult, "runId");
    const childSessionId = stringFromRecord(startResult, "childSessionId");
    if (!runId) throw new Error("openpond_subagent_start did not return a runId.");
    if (!childSessionId) throw new Error("openpond_subagent_start did not return a childSessionId.");

    await harness.events.waitFor(
      (event) =>
        event.sessionId === session.id &&
        event.name === "subagent.started" &&
        event.status === "started" &&
        stringFromRecord(asRecord(asRecord(event.data)?.run), "id") === runId,
      `subagent.started:${runId}`,
      { sessionId: session.id },
    );

    await harness.renderer.assertText("Pursuing goal", {
      label: "active goal strip status",
      timeoutMs: 10_000,
    });
    await harness.renderer.assertText(/1 subagent (running|submitted)/, {
      label: "goal strip subagent count",
      timeoutMs: 10_000,
    });
    harness.recordAssertion("composerGoalStripVisible", true);
    harness.recordAssertion("composerSubagentSummaryVisible", true);

    await openComposerGoalDetails(harness);
    await harness.renderer.assertText(goal.objective, {
      label: "composer inline goal objective",
      timeoutMs: 10_000,
    });
    harness.recordAssertion("composerGoalObjectiveVisible", true);

    await openRightSidebarGoalDetails(harness);
    await harness.renderer.assertText("Goal Details", { label: "right sidebar goal details title" });
    await harness.renderer.assertText("Subagents", { label: "right sidebar subagent section" });
    await harness.renderer.assertText(goal.objective, { label: "right sidebar goal objective" });
    await harness.renderer.assertText("Required submitted", { label: "right sidebar required-submitted row" });
    harness.recordAssertion("rightSidebarGoalDetailsVisible", true);
    harness.recordAssertion("rightSidebarSubagentDetailsVisible", true);
    await harness.screenshot("goal-scoped-subagent-details-active");

    const submittedEvent = await harness.events.waitForSubagentSubmitted(session.id, runId) as RuntimeEvent;
    await waitForCompletedTurn(harness, session.id, startEvent, "goal-scoped parent turn completion");

    const submittedRun = asRecord(asRecord(submittedEvent.data)?.run);
    const submittedChildSessionId = stringFromRecord(submittedRun, "childSessionId") ?? childSessionId;
    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    const childSession = bootstrap.sessions.find((item) => item.id === submittedChildSessionId);
    if (!childSession) throw new Error(`Child session ${submittedChildSessionId} was not present in bootstrap.`);

    await harness.renderer.assertText("Subagent submitted", {
      label: "goal-scoped subagent submitted activity",
    });
    harness.recordAssertion("subagentSubmittedVisible", true);
    harness.recordMetadata({
      runId,
      childSessionId: submittedChildSessionId,
      parentTurnId: startEvent.turnId ?? null,
      childParentGoalId: childSession.parentGoalId ?? null,
      runtimeEventCount: bootstrap.events.filter((event) => event.sessionId === session.id).length,
    });

    if (childSession.parentGoalId !== goal.id) {
      throw new Error(`Child session parentGoalId ${childSession.parentGoalId ?? "null"} did not match ${goal.id}.`);
    }

    await harness.screenshot("goal-scoped-subagent-details-complete");
  },
});

async function waitForGoalRuntimeEvent(
  harness: DesktopHarness,
  sessionId: string,
  goalId: string,
): Promise<RuntimeEvent> {
  return await harness.events.waitFor(
    (event) =>
      event.sessionId === sessionId &&
      event.name === "diagnostic" &&
      asRecord(event.data)?.kind === "thread_goal" &&
      stringFromRecord(asRecord(asRecord(event.data)?.goal), "id") === goalId,
    `thread_goal:${goalId}`,
    { sessionId },
  ) as RuntimeEvent;
}

async function openComposerGoalDetails(harness: DesktopHarness): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const toggle = document.querySelector('.composer-goal-toggle');
      if (!(toggle instanceof HTMLButtonElement)) return false;
      if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      return toggle.getAttribute('aria-expanded') === 'true';
    })()`,
    "composer goal details toggle",
    { timeoutMs: 10_000 },
  );
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
