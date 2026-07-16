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
  waitForAssistantOutput,
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
          !stringFromRecord(delivery, "wakeQueuedParentSessionId") &&
          stringFromRecord(delivery, "wakeParentReason") === "child_handoff_pending_submission"
        );
      },
      `parent deferred handoff wake for ${runId}`,
      { sessionId: session.id },
    ) as RuntimeEvent;

    const submittedEvent = await harness.events.waitForSubagentSubmitted(session.id, runId) as RuntimeEvent;
    const lifecycleWakeEvent = await waitForAssistantOutput(
      harness,
      session.id,
      `Watcher lifecycle review wake received for ${runId}.`,
      "submission-driven parent wake response",
    );
    if (lifecycleWakeEvent.turnId === startEvent.turnId) {
      throw new Error("Expected the lifecycle response in a queued parent wake turn, not the initial parent turn.");
    }
    await waitForCompletedTurn(harness, session.id, lifecycleWakeEvent, "queued parent wake turn completion");

    await harness.renderer.selectSession(session.id, { timeoutMs: 10_000 });
    await harness.renderer.assertText(title, { label: "handoff parent session after wake" });
    await harness.renderer.assertText("Research subagent update", { label: "handoff parent activity summary" });
    await harness.renderer.assertText(handoffBody, { label: "handoff body visible in parent" });
    await expandHandoffActivityDetails(harness);
    await harness.renderer.assertText("child_handoff_pending_submission", { label: "deferred handoff wake metadata value" });
    await harness.renderer.assertText(`Watcher lifecycle review wake received for ${runId}.`, {
      label: "queued parent wake response",
    });
    harness.recordAssertion("parentHandoffVisible", true);
    harness.recordAssertion("parentWakeDeferredUntilSubmission", true);
    harness.recordAssertion("queuedParentWakeTurnCompleted", true);
    await harness.screenshot("subagent-handoff-parent-wake-parent-metadata");

    const submittedRun = asRecord(asRecord(submittedEvent.data)?.run);
    const submittedChildSessionId = stringFromRecord(submittedRun, "childSessionId") ?? childSessionId;
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
    const prematureJoinEvents = bootstrap.events.filter((event) =>
      event.sessionId === session.id &&
      event.name === "tool.completed" &&
      event.action === "openpond_subagent_join"
    );
    if (parentStartEvents.length !== 1) {
      throw new Error(`Expected exactly one parent subagent start event, found ${parentStartEvents.length}.`);
    }
    if (parentHandoffMessages.length !== 1) {
      throw new Error(`Expected exactly one parent handoff message event, found ${parentHandoffMessages.length}.`);
    }
    if (prematureJoinEvents.length !== 0) {
      throw new Error(`Expected no premature parent join event, found ${prematureJoinEvents.length}.`);
    }
    const childSession = bootstrap.sessions.find((item) => item.id === submittedChildSessionId);
    if (!childSession) throw new Error(`Child session ${submittedChildSessionId} was not present in bootstrap.`);
    if (childSession.parentSessionId !== session.id) {
      throw new Error(`Child session ${submittedChildSessionId} was not linked to parent ${session.id}.`);
    }

    await expandChildSessionGroup(harness, session.id);
    await waitForSidebarSessionRow(harness, childSession.id, { timeoutMs: 10_000 });
    harness.recordAssertion("singleParentSubagentStart", true);
    harness.recordAssertion("singleParentHandoffMessage", true);
    harness.recordAssertion("noPrematureParentJoin", true);
    harness.recordAssertion("childSidebarRowVisible", true);

    await harness.renderer.selectSession(childSession.id);
    await harness.renderer.assertText("Research subagent submitted after sending the scripted parent handoff.", {
      label: "child handoff final text",
    });
    harness.recordAssertion("childConversationHandoffTextVisible", true);
    harness.recordMetadata({
      runId,
      childSessionId: submittedChildSessionId,
      initialParentTurnId: startEvent.turnId ?? null,
      wakeParentTurnId: lifecycleWakeEvent.turnId ?? null,
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
      const card = cards.find((candidate) => candidate.textContent?.includes(${expected}));
      if (!(card instanceof HTMLElement)) return false;
      const details = card.querySelector('details.activity-child-message-details');
      if (!(details instanceof HTMLDetailsElement)) return false;
      if (!details.open) details.open = true;
      return card.textContent?.includes('child_handoff_pending_submission') ?? false;
    })()`,
    "expanded handoff activity details",
    { timeoutMs: 10_000 },
  );
}
