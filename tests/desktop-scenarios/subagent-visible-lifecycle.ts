import type { BootstrapPayload, RuntimeEvent, Session } from "@openpond/contracts";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import {
  asRecord,
  configureResearchSubagentModel,
  expandChildSessionGroup,
  registerScriptedOpenPondModel,
  reloadRenderer,
  stringFromRecord,
  toolResultFromEvent,
  waitForCompletedTurn,
  waitForSidebarSessionRow,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "openpond-scripted-subagent-lifecycle",
};

export default desktopScenario({
  name: "subagent-visible-lifecycle",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);
    await configureResearchSubagentModel(harness, modelRef);

    const title = harness.uniqueTitle("subagent-visible-lifecycle");
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
    await harness.renderer.assertText(title, { label: "subagent scenario parent session title" });

    await harness.renderer.submitComposer("Start the scripted research subagent and report back.");
    const startEvent = await harness.events.waitForToolCompleted(
      session.id,
      "openpond_subagent_start",
    ) as RuntimeEvent;
    const startResult = toolResultFromEvent(startEvent);
    const runId = stringFromRecord(startResult, "runId");
    if (!runId) throw new Error("openpond_subagent_start did not return a runId.");

    await harness.events.waitForToolCompleted(session.id, "openpond_subagent_join") as RuntimeEvent;
    const submittedEvent = await harness.events.waitForSubagentSubmitted(session.id, runId) as RuntimeEvent;
    await waitForCompletedTurn(harness, session.id, startEvent, "parent subagent turn completion");

    const submittedRun = asRecord(asRecord(submittedEvent.data)?.run);
    const childSessionId = stringFromRecord(submittedRun, "childSessionId") ??
      stringFromRecord(startResult, "childSessionId");
    if (!childSessionId) throw new Error("Subagent submission did not include a child session id.");

    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    const childSession = bootstrap.sessions.find((item) => item.id === childSessionId);
    if (!childSession) throw new Error(`Child session ${childSessionId} was not present in bootstrap.`);
    if (childSession.parentSessionId !== session.id) {
      throw new Error(`Child session ${childSessionId} was not linked to parent ${session.id}.`);
    }

    await harness.renderer.assertText("Subagent submitted", { label: "parent subagent submitted activity" });
    await harness.renderer.assertText("Research subagent", { label: "research subagent activity label" });
    harness.recordAssertion("parentActivityVisible", true);

    await expandChildSessionGroup(harness, session.id);
    await waitForSidebarSessionRow(harness, childSession.id, { timeoutMs: 10_000 });
    harness.recordAssertion("childSidebarRowVisible", true);

    await harness.renderer.selectSession(childSessionId);
    await harness.renderer.assertText("Research subagent submitted the scripted lifecycle check.", {
      label: "child conversation final text",
    });
    harness.recordAssertion("childConversationLinked", true);
    harness.recordAssertion("childConversationTextVisible", true);
    harness.recordMetadata({
      runId,
      childSessionId,
      parentTurnId: startEvent.turnId ?? null,
      childSessionTitle: childSession.title,
      runtimeEventCount: bootstrap.events.filter((event) => event.sessionId === session.id).length,
    });

    await harness.renderer.selectSession(session.id);
    await harness.screenshot("subagent-visible-lifecycle-complete");
  },
});
