import type { BootstrapPayload, Session } from "@openpond/contracts";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import {
  registerScriptedOpenPondModel,
  reloadRenderer,
  waitForAssistantOutput,
  waitForCompletedTurn,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "openpond-scripted-chat-two-turns",
};

export default desktopScenario({
  name: "chat-two-turns",
  mode: "isolated",
  timeoutMs: 90_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);
    const title = harness.uniqueTitle("chat-two-turns");
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
    await harness.renderer.assertText(title, { label: "scenario session title" });

    const firstPrompt = "desktop harness first scripted prompt";
    await harness.renderer.submitComposer(firstPrompt);
    const firstOutput = `scripted turn 1 response for: ${firstPrompt}`;
    const firstDelta = await waitForAssistantOutput(harness, session.id, firstOutput, "first assistant delta");
    await waitForCompletedTurn(harness, session.id, firstDelta, "first turn completion");
    await harness.renderer.assertText(firstOutput, { label: "first scripted response visible" });
    harness.recordAssertion("firstAssistantVisible", true);

    const secondPrompt = "desktop harness second scripted prompt";
    await harness.renderer.submitComposer(secondPrompt);
    const secondOutput = `scripted turn 2 response for: ${secondPrompt}`;
    const secondDelta = await waitForAssistantOutput(harness, session.id, secondOutput, "second assistant delta");
    await waitForCompletedTurn(harness, session.id, secondDelta, "second turn completion");
    await harness.renderer.assertText(secondOutput, { label: "second scripted response visible" });

    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    const sessionEvents = bootstrap.events.filter((event) => event.sessionId === session.id);
    const completedTurnIds = new Set(
      sessionEvents
        .filter((event) => event.name === "turn.completed" && event.status === "completed" && event.turnId)
        .map((event) => event.turnId),
    );
    harness.recordAssertion("sessionInBootstrap", bootstrap.sessions.some((item) => item.id === session.id));
    harness.recordAssertion("twoCompletedTurnsPersisted", completedTurnIds.size >= 2);
    harness.recordAssertion("secondAssistantVisible", true);
    harness.recordMetadata({
      firstTurnId: firstDelta.turnId ?? null,
      secondTurnId: secondDelta.turnId ?? null,
      runtimeEventCount: sessionEvents.length,
    });

    await harness.screenshot("chat-two-turns-complete");
  },
});
