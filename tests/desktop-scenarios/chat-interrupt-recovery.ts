import type { RuntimeEvent, Session } from "@openpond/contracts";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import {
  registerScriptedOpenPondModel,
  reloadRenderer,
  waitForAssistantOutput,
  waitForCompletedTurn,
  waitForRendererCondition,
  waitForSidebarSessionRow,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "openpond-scripted-chat-interrupt-recovery",
};

type RuntimeEventPage = {
  events: Array<{ sequence: number; event: RuntimeEvent }>;
};

export default desktopScenario({
  name: "chat-interrupt-recovery",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);
    const title = harness.uniqueTitle("chat-interrupt-recovery");
    const session = await harness.api.createSession<Session>({
      experience: "chat",
      provider: "openpond",
      modelRef,
      title,
      cwd: harness.repoRoot,
    });

    await reloadRenderer(harness);
    await waitForSidebarSessionRow(harness, session.id);
    await harness.renderer.selectSession(session.id);

    const interruptedPrompt = "stream until the visible stop control interrupts this turn";
    await harness.renderer.submitComposer(interruptedPrompt);
    await waitForRendererCondition(
      harness,
      `Boolean(document.querySelector('button[aria-label="Stop response"]'))`,
      "visible Stop response control",
      { timeoutMs: 2_000, intervalMs: 50 },
    );
    const interruptionStartedAt = Date.now();
    const clickedStop = await harness.renderer.evaluate<boolean>(
      `(() => {
        const button = [...document.querySelectorAll('button[aria-label="Stop response"]')]
          .find((candidate) => candidate instanceof HTMLButtonElement && candidate.offsetParent !== null);
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`,
    );
    if (!clickedStop) throw new Error("The visible Stop response control was not clickable.");

    const interruptedEvent = await waitForPersistedInterrupt(harness, session.id);
    const interruptionMs = Date.now() - interruptionStartedAt;
    if (interruptionMs >= 2_000) {
      throw new Error(`Visible turn interruption took ${interruptionMs} ms.`);
    }
    await harness.renderer.assertText(interruptedPrompt, {
      label: "interrupted prompt visible after interruption",
    });

    const followUpPrompt = "follow-up after interruption";
    await harness.renderer.submitComposer(followUpPrompt);
    const followUpOutput = `recovered response for: ${followUpPrompt}`;
    const followUpDelta = await waitForAssistantOutput(
      harness,
      session.id,
      followUpOutput,
      "completed response after interruption",
    );
    await waitForCompletedTurn(
      harness,
      session.id,
      followUpDelta,
      "follow-up completion after interruption",
    );
    await harness.renderer.assertText(followUpOutput, {
      label: "follow-up response visible",
    });

    await reloadRenderer(harness);
    await waitForSidebarSessionRow(harness, session.id);
    await harness.renderer.selectSession(session.id);
    await harness.renderer.assertText(interruptedPrompt, {
      label: "interrupted prompt persisted",
    });
    await harness.renderer.assertText(followUpPrompt, {
      label: "follow-up prompt persisted",
    });
    await harness.renderer.assertText(followUpOutput, {
      label: "follow-up output persisted",
    });

    const page = await harness.api.eventPage<RuntimeEventPage>({
      sessionId: session.id,
      afterSequence: 0,
      limit: 100,
    });
    const events = page.events.map((entry) => entry.event);
    const interruptedTurnCompleted = events.some(
      (event) =>
        event.turnId === interruptedEvent.turnId &&
        event.name === "turn.completed",
    );
    const followUpCompleted = events.some(
      (event) =>
        event.turnId === followUpDelta.turnId &&
        event.name === "turn.completed" &&
        event.status === "completed",
    );
    if (interruptedTurnCompleted) {
      throw new Error("The interrupted turn also emitted a completion event.");
    }
    if (!followUpCompleted) {
      throw new Error("The follow-up turn did not persist its completion event.");
    }

    harness.recordAssertion("visibleStopControlWorked", true);
    harness.recordAssertion("interruptedTurnDidNotComplete", true);
    harness.recordAssertion("followUpCompleted", true);
    harness.recordAssertion("reloadedRecoveryTranscriptVisible", true);
    harness.recordMetadata({
      sessionId: session.id,
      interruptedTurnId: interruptedEvent.turnId ?? null,
      followUpTurnId: followUpDelta.turnId ?? null,
      interruptionMs,
      interruptedOutput: interruptedEvent.output ?? null,
    });
    await harness.screenshot("chat-interrupt-recovery-complete");
  },
});

async function waitForPersistedInterrupt(
  harness: DesktopHarness,
  sessionId: string,
): Promise<RuntimeEvent> {
  const startedAt = Date.now();
  let latestEvents: RuntimeEvent[] = [];
  while (Date.now() - startedAt < 2_000) {
    const page = await harness.api.eventPage<RuntimeEventPage>({
      sessionId,
      afterSequence: 0,
      limit: 100,
    });
    latestEvents = page.events.map((entry) => entry.event);
    const interrupted = latestEvents
      .find((event) => event.sessionId === sessionId && event.name === "turn.interrupted");
    if (interrupted) return interrupted;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `The visible Stop response control did not persist a turn.interrupted event within 2 seconds. Events: ${JSON.stringify(latestEvents.map((event) => ({ name: event.name, status: event.status, turnId: event.turnId })))}.`,
  );
}
