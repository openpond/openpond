import type { BootstrapPayload, RuntimeEvent, Session, Turn } from "@openpond/contracts";

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
  modelId: "openpond-scripted-chat-delayed-stream",
};

type StressThread = {
  session: Session;
  prompt: string;
  output: string;
};

type RuntimeEventPage = {
  events: Array<{ sequence: number; event: RuntimeEvent }>;
};

export default desktopScenario({
  name: "chat-multi-thread-stress",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);

    const threads = await Promise.all(
      ["alpha", "bravo", "charlie"].map(async (suffix): Promise<StressThread> => {
        const prompt = `multi-thread ${suffix} prompt`;
        const session = await harness.api.createSession<Session>({
          experience: "chat",
          provider: "openpond",
          modelRef,
          title: harness.uniqueTitle(`chat-stress-${suffix}`),
          cwd: harness.repoRoot,
        });
        return {
          session,
          prompt,
          output: `delayed stream response for: ${prompt} complete`,
        };
      }),
    );

    const initialReloadStartedAt = Date.now();
    await reloadRenderer(harness);
    await Promise.all(threads.map(({ session }) => waitForSidebarSessionRow(harness, session.id)));
    const sidebarReadyMs = Date.now() - initialReloadStartedAt;

    await harness.renderer.selectSession(threads[0]!.session.id);
    const backgroundTurns = threads.slice(1).map(({ session, prompt }) =>
      harness.api.createTurn<Turn>(session.id, { prompt, modelRef })
    );
    await harness.renderer.submitComposer(threads[0]!.prompt);

    const startedEvents = await Promise.all(
      threads.map(({ session }) => harness.events.waitForName(session.id, "turn.started")),
    );
    const bravoFirstDelta = await harness.events.waitFor(
      (event) =>
        event.sessionId === threads[1]!.session.id &&
        event.name === "assistant.delta" &&
        event.output === "delayed stream response",
      "bravo first streamed chunk",
      { sessionId: threads[1]!.session.id },
    );

    const selectedThreadStayedIsolated = await harness.renderer.evaluate<boolean>(
      `(() => {
        const selected = document.querySelector('[data-session-id].selected');
        const conversation = document.querySelector('.chat-thread[aria-label="Conversation"]');
        return selected?.getAttribute('data-session-id') === ${JSON.stringify(threads[0]!.session.id)} &&
          conversation instanceof HTMLElement &&
          !conversation.innerText.includes(${JSON.stringify(threads[1]!.prompt)});
      })()`,
    );
    harness.recordAssertion("selectedThreadStayedIsolated", selectedThreadStayedIsolated);
    if (!selectedThreadStayedIsolated) {
      throw new Error("A background thread changed the selected thread transcript.");
    }

    const alphaFirstDelta = await waitForAssistantOutput(
      harness,
      threads[0]!.session.id,
      "delayed stream response",
      "alpha first streamed chunk",
    );
    const charlieFirstDelta = await waitForAssistantOutput(
      harness,
      threads[2]!.session.id,
      "delayed stream response",
      "charlie first streamed chunk",
    );

    await Promise.all(backgroundTurns);
    const firstDeltas = [alphaFirstDelta, bravoFirstDelta, charlieFirstDelta] as RuntimeEvent[];
    await Promise.all(
      threads.map(({ session }, index) =>
        waitForCompletedTurn(harness, session.id, firstDeltas[index]!, `${session.title} completion`)
      ),
    );

    const switchTimingsMs: number[] = [];
    for (const thread of threads) {
      const switchStartedAt = Date.now();
      await harness.renderer.selectSession(thread.session.id);
      await harness.renderer.assertText(thread.prompt, { label: `${thread.session.title} user text` });
      await harness.renderer.assertText(thread.output, { label: `${thread.session.title} assistant text` });
      switchTimingsMs.push(Date.now() - switchStartedAt);
    }

    const settledReloadStartedAt = Date.now();
    await reloadRenderer(harness);
    for (const thread of threads) {
      await waitForSidebarSessionRow(harness, thread.session.id);
      await harness.renderer.selectSession(thread.session.id);
      await harness.renderer.assertText(thread.prompt, { label: `${thread.session.title} reloaded user text` });
      await harness.renderer.assertText(thread.output, { label: `${thread.session.title} reloaded assistant text` });
    }
    const settledReloadMs = Date.now() - settledReloadStartedAt;

    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    const persistedSessionIds = new Set(bootstrap.sessions.map((session) => session.id));
    const persistedEventProof = await Promise.all(
      threads.map(async ({ session }) => {
        const page = await harness.api.eventPage<RuntimeEventPage>({
          sessionId: session.id,
          afterSequence: 0,
          limit: 100,
        });
        const events = page.events.map((entry) => entry.event);
        return {
          sessionId: session.id,
          assistantDelta: events.some((event) => event.name === "assistant.delta"),
          completed: events.some((event) => event.name === "turn.completed" && event.status === "completed"),
        };
      }),
    );

    const allSessionsPersisted = threads.every(({ session }) => persistedSessionIds.has(session.id));
    const allTranscriptsPersisted = persistedEventProof.every(
      (proof) => proof.assistantDelta && proof.completed,
    );
    harness.recordAssertion("allSessionsPersisted", allSessionsPersisted);
    harness.recordAssertion("allTranscriptsPersisted", allTranscriptsPersisted);
    harness.recordAssertion("allReloadedTextVisible", true);
    if (!allSessionsPersisted || !allTranscriptsPersisted) {
      throw new Error("One or more stress threads were not durable after renderer reload.");
    }
    harness.recordMetadata({
      modelRef,
      sessionIds: threads.map(({ session }) => session.id),
      sidebarReadyMs,
      switchTimingsMs,
      settledReloadMs,
      persistedEventProof,
      turnIds: startedEvents.map((event) => event.turnId ?? null),
    });

    await waitForRendererCondition(
      harness,
      `document.querySelectorAll('[data-session-id].selected').length === 1`,
      "one selected session after stress run",
    );
    await harness.screenshot("chat-multi-thread-stress-complete");
  },
});
