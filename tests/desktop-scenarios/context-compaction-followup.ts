import type { BootstrapPayload, RuntimeEvent, Session } from "@openpond/contracts";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import {
  asRecord,
  registerScriptedOpenPondModel,
  reloadRenderer,
  waitForAssistantOutput,
  waitForCompletedTurn,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "openpond-scripted-chat-two-turns",
};

type CompactSessionResponse = {
  ok: boolean;
  mode: string;
  summaryEventId: string | null;
  inputTokensBefore?: number;
  inputTokensAfter?: number;
  maxContextTokens?: number;
  tokenSource?: string;
};

export default desktopScenario({
  name: "context-compaction-followup",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);

    const title = harness.uniqueTitle("context-compaction-followup");
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
    await harness.renderer.assertText(title, { label: "compaction session title" });

    const firstPrompt = "desktop harness compaction seed prompt with durable context alpha";
    await harness.renderer.submitComposer(firstPrompt);
    const firstDelta = await waitForAssistantOutput(harness, session.id, `for: ${firstPrompt}`, "first seed response");
    await waitForCompletedTurn(harness, session.id, firstDelta, "first seed turn completion");
    harness.recordAssertion("firstSeedTurnVisible", true);

    const secondPrompt = "desktop harness compaction seed prompt with recent context beta";
    await harness.renderer.submitComposer(secondPrompt);
    const secondDelta = await waitForAssistantOutput(harness, session.id, `for: ${secondPrompt}`, "second seed response");
    await waitForCompletedTurn(harness, session.id, secondDelta, "second seed turn completion");
    harness.recordAssertion("secondSeedTurnVisible", true);

    const compacted = await harness.api.fetchJson<CompactSessionResponse>(
      `/v1/sessions/${encodeURIComponent(session.id)}/compact`,
      {
        method: "POST",
        body: {
          reason: "manual",
          model: modelRef.modelId,
        },
      },
    );
    if (!compacted.ok) throw new Error("Manual compaction did not report ok=true.");
    if (compacted.mode !== "summary") throw new Error(`Manual compaction returned unexpected mode ${compacted.mode}.`);
    if (!compacted.summaryEventId) throw new Error("Manual compaction did not return a summaryEventId.");

    const startedEvent = await harness.events.waitFor(
      (event) =>
        event.sessionId === session.id &&
        event.name === "session.compaction.started" &&
        asRecord(event.data)?.reason === "manual",
      "manual compaction started",
      { sessionId: session.id },
    ) as RuntimeEvent;
    const completedEvent = await harness.events.waitFor(
      (event) =>
        event.sessionId === session.id &&
        event.id === compacted.summaryEventId &&
        event.name === "session.compaction.completed" &&
        event.status === "completed",
      "manual compaction completed",
      { sessionId: session.id },
    ) as RuntimeEvent;
    const completedData = asRecord(completedEvent.data);
    if (typeof completedData?.summary !== "string" || !completedData.summary.trim()) {
      throw new Error("Compaction completed without a persisted summary.");
    }

    await harness.renderer.assertText("Compacted context", {
      label: "manual compaction status divider",
      timeoutMs: 15_000,
    });
    harness.recordAssertion("manualCompactionVisible", true);
    await harness.screenshot("context-compaction-complete");

    const followUpPrompt = "post-compaction visible follow-up prompt";
    await harness.renderer.submitComposer(followUpPrompt);
    const followUpDelta = await waitForAssistantOutput(
      harness,
      session.id,
      `for: ${followUpPrompt}`,
      "post-compaction follow-up response",
    );
    await waitForCompletedTurn(harness, session.id, followUpDelta, "post-compaction follow-up completion");
    await harness.renderer.assertText(/scripted turn \d+ response for: post-compaction visible follow-up prompt/, {
      label: "post-compaction assistant response visible",
      timeoutMs: 15_000,
    });
    harness.recordAssertion("postCompactionFollowUpVisible", true);

    const usage = await harness.api.usageRecords<{ records?: Array<Record<string, unknown>> }>({
      range: "all",
      limit: 20,
    });
    const compactionUsage = (usage.records ?? []).find((record) =>
      record.sessionId === session.id && record.requestKind === "context_compaction"
    );
    if (!compactionUsage) throw new Error("Manual compaction did not record context_compaction usage.");
    harness.recordAssertion("contextCompactionUsageRecorded", true);

    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    const sessionEvents = bootstrap.events.filter((event) => event.sessionId === session.id);
    harness.recordMetadata({
      compactionStartedEventId: startedEvent.id,
      summaryEventId: compacted.summaryEventId,
      compactedThroughEventId: typeof completedData.compactedThroughEventId === "string"
        ? completedData.compactedThroughEventId
        : null,
      compactedThroughTurnId: typeof completedData.compactedThroughTurnId === "string"
        ? completedData.compactedThroughTurnId
        : null,
      preservedEventIds: Array.isArray(completedData.preservedEventIds)
        ? completedData.preservedEventIds.filter((item): item is string => typeof item === "string")
        : [],
      firstTurnId: firstDelta.turnId ?? null,
      secondTurnId: secondDelta.turnId ?? null,
      followUpTurnId: followUpDelta.turnId ?? null,
      inputTokensBefore: compacted.inputTokensBefore ?? null,
      inputTokensAfter: compacted.inputTokensAfter ?? null,
      maxContextTokens: compacted.maxContextTokens ?? null,
      tokenSource: compacted.tokenSource ?? null,
      runtimeEventCount: sessionEvents.length,
    });

    await harness.screenshot("context-compaction-followup-complete");
  },
});
