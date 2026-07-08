import type { BootstrapPayload, RuntimeEvent, Session } from "@openpond/contracts";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import {
  asRecord,
  configureResearchSubagentModel,
  expandChildSessionGroup,
  registerScriptedOpenPondModel,
  reloadRenderer,
  stringFromRecord,
  toolResultFromEvent,
  waitForRendererCondition,
  waitForSidebarSessionRow,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "openpond-scripted-subagent-running-delay",
};

export default desktopScenario({
  name: "subagent-running-state",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);
    await configureResearchSubagentModel(harness, modelRef);

    const title = harness.uniqueTitle("subagent-running-state");
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
    await harness.renderer.assertText(title, { label: "running-state parent session title" });

    await harness.renderer.submitComposer("Start the scripted research subagent and keep it visible while it runs.");
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
        asRecord(event.data)?.run &&
        stringFromRecord(asRecord(asRecord(event.data)?.run), "id") === runId,
      `subagent.started:${runId}`,
      { sessionId: session.id },
    );

    await harness.renderer.assertText("Subagent running", {
      label: "running subagent activity row",
      timeoutMs: 10_000,
    });
    await waitForParentSubagentRunningDot(harness, session.id);
    harness.recordAssertion("parentActivityRunningVisible", true);
    harness.recordAssertion("sidebarRunningDotVisible", true);
    await harness.screenshot("subagent-running-state-active");

    const completedEvent = await harness.events.waitForSubagentCompleted(session.id, runId) as RuntimeEvent;
    const completedRun = asRecord(asRecord(completedEvent.data)?.run);
    const completedChildSessionId = stringFromRecord(completedRun, "childSessionId") ?? childSessionId;
    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    const childSession = bootstrap.sessions.find((item) => item.id === completedChildSessionId);
    if (!childSession) throw new Error(`Child session ${completedChildSessionId} was not present in bootstrap.`);

    await harness.renderer.assertText("Subagent completed", {
      label: "completed subagent activity row",
    });
    await expandChildSessionGroup(harness, session.id);
    await waitForSidebarSessionRow(harness, childSession.id, { timeoutMs: 10_000 });
    harness.recordAssertion("subagentCompletionVisible", true);
    harness.recordAssertion("childSidebarRowVisible", true);
    harness.recordMetadata({
      runId,
      childSessionId: completedChildSessionId,
      parentTurnId: startEvent.turnId ?? null,
      runtimeEventCount: bootstrap.events.filter((event) => event.sessionId === session.id).length,
    });

    await harness.screenshot("subagent-running-state-complete");
  },
});

async function waitForParentSubagentRunningDot(
  harness: DesktopHarness,
  parentSessionId: string,
): Promise<void> {
  const selector = JSON.stringify(`[data-session-id="${parentSessionId}"]`);
  await waitForRendererCondition(
    harness,
    `(() => {
      const row = document.querySelector(${selector});
      if (!(row instanceof HTMLElement)) return false;
      const shell = row.closest('.sidebar-session-row-shell') ?? row;
      return Boolean(
        row.classList.contains('has-running-dot') &&
        shell.querySelector('.sidebar-running-dot.subagent[aria-label*="subagent running"]')
      );
    })()`,
    `parent sidebar subagent running dot for ${parentSessionId}`,
    { timeoutMs: 10_000 },
  );
}
