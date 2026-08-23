import type {
  BootstrapPayload,
  ModelUsageRecord,
  RuntimeEvent,
  Session,
  Turn,
  UsageRecordsResponse,
} from "@openpond/contracts";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import {
  reloadRenderer,
  waitForAssistantOutput,
  waitForCompletedTurn,
  waitForSidebarSessionRow,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "accounts/fireworks/models/deepseek-v4-flash",
};

const CONSERVATIVE_USD_PER_MILLION_TOKENS = 4;
const HARD_COST_CEILING_USD = 1.5;

type LiveThread = {
  session: Session;
  prompt: string;
  expected: string;
};

export default desktopScenario({
  name: "chat-deepseek-live-stress",
  mode: "attach",
  timeoutMs: 180_000,
  async run(harness) {
    const resumeSessionIds = process.env.OPENPOND_LIVE_DEEPSEEK_SESSION_IDS
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const before = await harness.api.usageRecords<UsageRecordsResponse>({
      range: "all",
      limit: 200,
    });
    const usageIdsBefore = new Set(before.records.map((record) => record.id));

    const threads = resumeSessionIds?.length
      ? await resumedThreads(harness, resumeSessionIds)
      : await Promise.all(
          ["ALPHA", "BRAVO", "CHARLIE"].map(
            async (suffix): Promise<LiveThread> => {
          const expected = `POND-${suffix}`;
          const prompt = `Reply with exactly ${expected} and nothing else.`;
          const session = await harness.api.createSession<Session>({
            experience: "chat",
            provider: "openpond",
            modelRef,
            title: harness.uniqueTitle(`deepseek-live-${suffix.toLowerCase()}`),
            cwd: harness.repoRoot,
          });
          return { session, prompt, expected };
            },
          ),
        );

    if (!resumeSessionIds?.length) {
      const turns = threads.map(({ session, prompt }) =>
        harness.api.createTurn<Turn>(session.id, { prompt, modelRef }),
      );

      const firstDeltas = await Promise.all(
        threads.map(({ session, expected }) =>
          waitForAssistantOutput(
            harness,
            session.id,
            expected,
            `${session.title} DeepSeek response`,
          ),
        ),
      );

      await Promise.all(turns);
      await Promise.all(
        threads.map(({ session }, index) =>
          waitForCompletedTurn(
            harness,
            session.id,
            firstDeltas[index] as RuntimeEvent,
            `${session.title} completion`,
          ),
        ),
      );
    }

    await reloadRenderer(harness);
    await Promise.all(
      threads.map(({ session }) => waitForSidebarSessionRow(harness, session.id)),
    );
    const firstTranscriptStartedAt = Date.now();
    await harness.renderer.selectSession(threads[0]!.session.id);
    await harness.renderer.assertText(threads[0]!.prompt, {
      label: `${threads[0]!.session.title} initial prompt`,
    });
    await harness.renderer.assertText(threads[0]!.expected, {
      label: `${threads[0]!.session.title} initial DeepSeek output`,
    });
    const firstTranscriptReadyMs = Date.now() - firstTranscriptStartedAt;
    const selectedThreadStayedIsolated = await harness.renderer.evaluate<boolean>(
      `(() => {
        const selected = document.querySelector('[data-session-id].selected');
        const conversation = document.querySelector('.chat-thread[aria-label="Conversation"]');
        return selected?.getAttribute('data-session-id') === ${JSON.stringify(threads[0]!.session.id)} &&
          conversation instanceof HTMLElement &&
          !conversation.innerText.includes(${JSON.stringify(threads[1]!.expected)});
      })()`,
    );
    harness.recordAssertion(
      "selectedThreadStayedIsolated",
      selectedThreadStayedIsolated,
    );
    if (!selectedThreadStayedIsolated) {
      throw new Error("A background DeepSeek thread contaminated the selected transcript.");
    }

    for (const thread of threads) {
      await harness.renderer.selectSession(thread.session.id);
      await harness.renderer.assertText(thread.prompt, {
        label: `${thread.session.title} prompt`,
      });
      await harness.renderer.assertText(thread.expected, {
        label: `${thread.session.title} DeepSeek output`,
      });
    }

    await reloadRenderer(harness);
    for (const thread of threads) {
      await waitForSidebarSessionRow(harness, thread.session.id);
      await harness.renderer.selectSession(thread.session.id);
      await harness.renderer.assertText(thread.expected, {
        label: `${thread.session.title} persisted DeepSeek output`,
      });
    }

    const after = await harness.api.usageRecords<UsageRecordsResponse>({
      range: "all",
      limit: 200,
    });
    const sessionIds = new Set(threads.map(({ session }) => session.id));
    const liveRecords = after.records.filter(
      (record) =>
        (resumeSessionIds?.length || !usageIdsBefore.has(record.id)) &&
        record.sessionId !== null &&
        sessionIds.has(record.sessionId),
    );
    assertAllowedUsage(liveRecords);
    const knownTotalTokens = liveRecords.reduce(
      (total, record) => total + (record.totalTokens ?? 0),
      0,
    );
    const estimatedCostCeilingUsd =
      (knownTotalTokens * CONSERVATIVE_USD_PER_MILLION_TOKENS) / 1_000_000;
    if (estimatedCostCeilingUsd > HARD_COST_CEILING_USD) {
      throw new Error(
        `Live DeepSeek stress exceeded its $${HARD_COST_CEILING_USD.toFixed(2)} safety ceiling.`,
      );
    }

    harness.recordAssertion("onlyDeepSeekV4FlashUsed", true);
    harness.recordAssertion("allThreeOutputsVisibleAfterReload", true);
    harness.recordAssertion("costSafetyCeilingRespected", true);
    harness.recordMetadata({
      modelRef,
      sessionIds: [...sessionIds],
      usageRecordCount: liveRecords.length,
      usageStatuses: liveRecords.map((record) => record.status),
      knownTotalTokens,
      conservativeUsdPerMillionTokens: CONSERVATIVE_USD_PER_MILLION_TOKENS,
      estimatedCostCeilingUsd,
      resumedExistingTurns: Boolean(resumeSessionIds?.length),
      firstTranscriptReadyMs,
    });
    await harness.screenshot("chat-deepseek-live-stress-complete");
  },
});

async function resumedThreads(
  harness: DesktopHarness,
  sessionIds: string[],
): Promise<LiveThread[]> {
  if (sessionIds.length !== 3) {
    throw new Error("OPENPOND_LIVE_DEEPSEEK_SESSION_IDS must contain exactly 3 session IDs.");
  }
  const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
  return ["ALPHA", "BRAVO", "CHARLIE"].map((suffix) => {
    const session = bootstrap.sessions.find(
      (candidate) =>
        sessionIds.includes(candidate.id) &&
        candidate.title?.toLowerCase().includes(suffix.toLowerCase()),
    );
    if (!session) throw new Error(`Could not find resumed DeepSeek ${suffix} session.`);
    const expected = `POND-${suffix}`;
    return {
      session,
      prompt: `Reply with exactly ${expected} and nothing else.`,
      expected,
    };
  });
}

function assertAllowedUsage(records: ModelUsageRecord[]): void {
  if (records.length < 3) {
    throw new Error(`Expected at least 3 live usage records, received ${records.length}.`);
  }
  const disallowed = records.filter((record) => record.model !== modelRef.modelId);
  if (disallowed.length > 0) {
    throw new Error(
      `Live stress used a disallowed model: ${disallowed
        .map((record) => record.model)
        .join(", ")}`,
    );
  }
  const failed = records.filter((record) => record.status !== "completed");
  if (failed.length > 0) {
    throw new Error(
      `Live DeepSeek usage did not complete cleanly: ${failed
        .map((record) => record.status)
        .join(", ")}`,
    );
  }
}
