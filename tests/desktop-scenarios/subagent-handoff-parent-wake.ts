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
  waitForCompletedTurn,
  waitForRendererCondition,
  waitForSidebarSessionRow,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "openpond-scripted-subagent-handoff",
};

const handoffBody = "Scripted child handoff from the desktop harness.";

export default desktopScenario({
  name: "subagent-handoff-parent-wake",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);
    await configureResearchSubagentModel(harness, modelRef);

    const title = harness.uniqueTitle("subagent-handoff-parent-wake");
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
    await harness.renderer.assertText(title, { label: "handoff parent session title" });

    await harness.renderer.submitComposer("Start the scripted research subagent and let it hand off back to this chat.");
    const startEvent = await harness.events.waitForToolCompleted(
      session.id,
      "openpond_subagent_start",
    ) as RuntimeEvent;
    const startResult = toolResultFromEvent(startEvent);
    const runId = stringFromRecord(startResult, "runId");
    const childSessionId = stringFromRecord(startResult, "childSessionId");
    if (!runId) throw new Error("openpond_subagent_start did not return a runId.");
    if (!childSessionId) throw new Error("openpond_subagent_start did not return a childSessionId.");

    await waitForCompletedTurn(harness, session.id, startEvent, "initial parent handoff turn completion");
    await harness.renderer.assertText(`Research subagent handoff child started for ${runId}.`, {
      label: "initial parent handoff response",
    });

    const messageEvent = await harness.events.waitFor(
      (event) => {
        if (event.sessionId !== session.id || event.name !== "subagent.message") return false;
        const data = asRecord(event.data);
        const message = asRecord(data?.message);
        const delivery = asRecord(data?.delivery);
        return (
          stringFromRecord(message, "kind") === "handoff" &&
          stringFromRecord(message, "body") === handoffBody &&
          stringFromRecord(delivery, "wakeQueuedParentSessionId") === session.id &&
          stringFromRecord(delivery, "wakeParentReason") === "parent_wake_queued"
        );
      },
      `parent queued handoff wake for ${runId}`,
      { sessionId: session.id },
    ) as RuntimeEvent;

    const joinEvent = await harness.events.waitForToolCompleted(
      session.id,
      "openpond_subagent_join",
    ) as RuntimeEvent;
    if (joinEvent.turnId === startEvent.turnId) {
      throw new Error("Expected openpond_subagent_join to run in the queued parent wake turn, not the initial parent turn.");
    }
    await waitForCompletedTurn(harness, session.id, joinEvent, "queued parent wake turn completion");
    const completedEvent = await harness.events.waitForSubagentCompleted(session.id, runId) as RuntimeEvent;

    await harness.renderer.selectSession(session.id, { timeoutMs: 10_000 });
    await harness.renderer.assertText(title, { label: "handoff parent session after wake" });
    await harness.renderer.assertText("Child Message Received", { label: "handoff parent activity summary" });
    await harness.renderer.assertText(handoffBody, { label: "handoff body visible in parent" });
    await expandHandoffActivityDetails(harness);
    await harness.renderer.assertText("parent_wake_queued", { label: "handoff wake metadata value" });
    await harness.renderer.assertText("Research subagent lifecycle complete for", {
      label: "queued parent wake response",
    });
    harness.recordAssertion("parentHandoffVisible", true);
    harness.recordAssertion("parentWakeQueuedMetadataVisible", true);
    harness.recordAssertion("queuedParentWakeTurnCompleted", true);
    await harness.screenshot("subagent-handoff-parent-wake-parent-metadata");

    const completedRun = asRecord(asRecord(completedEvent.data)?.run);
    const completedChildSessionId = stringFromRecord(completedRun, "childSessionId") ?? childSessionId;
    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    const parentStartEvents = bootstrap.events.filter((event) =>
      event.sessionId === session.id &&
      event.name === "tool.completed" &&
      event.action === "openpond_subagent_start"
    );
    const parentHandoffMessages = bootstrap.events.filter((event) => {
      if (event.sessionId !== session.id || event.name !== "subagent.message") return false;
      const data = asRecord(event.data);
      const message = asRecord(data?.message);
      return stringFromRecord(message, "body") === handoffBody;
    });
    if (parentStartEvents.length !== 1) {
      throw new Error(`Expected exactly one parent subagent start event, found ${parentStartEvents.length}.`);
    }
    if (parentHandoffMessages.length !== 1) {
      throw new Error(`Expected exactly one parent handoff message event, found ${parentHandoffMessages.length}.`);
    }
    const childSession = bootstrap.sessions.find((item) => item.id === completedChildSessionId);
    if (!childSession) throw new Error(`Child session ${completedChildSessionId} was not present in bootstrap.`);
    if (childSession.parentSessionId !== session.id) {
      throw new Error(`Child session ${completedChildSessionId} was not linked to parent ${session.id}.`);
    }

    await expandChildSessionGroup(harness, session.id);
    await waitForSidebarSessionRow(harness, childSession.id, { timeoutMs: 10_000 });
    harness.recordAssertion("singleParentSubagentStart", true);
    harness.recordAssertion("singleParentHandoffMessage", true);
    harness.recordAssertion("childSidebarRowVisible", true);

    await harness.renderer.selectSession(childSession.id);
    await harness.renderer.assertText("Research subagent completed after sending the scripted parent handoff.", {
      label: "child handoff final text",
    });
    harness.recordAssertion("childConversationHandoffTextVisible", true);
    harness.recordMetadata({
      runId,
      childSessionId: completedChildSessionId,
      initialParentTurnId: startEvent.turnId ?? null,
      wakeParentTurnId: joinEvent.turnId ?? null,
      parentMessageEventId: messageEvent.id ?? null,
      runtimeEventCount: bootstrap.events.filter((event) => event.sessionId === session.id).length,
    });

    await harness.renderer.selectSession(session.id);
    await harness.screenshot("subagent-handoff-parent-wake-complete");
  },
});

async function expandHandoffActivityDetails(harness: DesktopHarness): Promise<void> {
  const expected = JSON.stringify(handoffBody);
  await waitForRendererCondition(
    harness,
    `(() => {
      const cards = Array.from(document.querySelectorAll('.activity-child-message-card'));
      const visibleCard = cards.find((candidate) =>
        candidate.textContent?.includes(${expected}) &&
        candidate.textContent?.includes('parent_wake_queued')
      );
      if (visibleCard) return true;
      const buttons = Array.from(document.querySelectorAll('.activity-summary'));
      const button = buttons.find((candidate) => candidate.textContent?.includes(${expected}));
      if (!(button instanceof HTMLButtonElement)) return false;
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
      return false;
    })()`,
    "expanded handoff activity details",
    { timeoutMs: 10_000 },
  );
}
