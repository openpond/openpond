import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RuntimeEvent, Session } from "@openpond/contracts";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import {
  asRecord,
  registerScriptedOpenPondModel,
  reloadRenderer,
  waitForAssistantOutput,
  waitForCompletedTurn,
  waitForRendererCondition,
  waitForSidebarSessionRow,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "openpond-scripted-packaged-long-turn-32k",
};
const finalMarker = "DESKTOP-LONG-TURN-COMPACTION-OK";

type RuntimeEventPage = {
  events: Array<{ sequence: number; event: RuntimeEvent }>;
};

export default desktopScenario({
  name: "packaged-long-turn-compaction",
  mode: "isolated",
  timeoutMs: 240_000,
  async run(harness) {
    const workspace = await mkdtemp(path.join(tmpdir(), "openpond-packaged-long-turn-"));
    try {
      for (let index = 0; index < 3; index += 1) {
        const header = `OPENPOND-LONG-TURN-FILE-${index}\n`;
        await writeFile(
          path.join(workspace, `large-${index}.log`),
          header + `${String(index)}-deterministic-payload\n`.repeat(1_800),
          "utf8",
        );
      }

      await registerScriptedOpenPondModel(harness, modelRef);
      const longTitle = harness.uniqueTitle("packaged-long-turn");
      const controlTitle = harness.uniqueTitle("packaged-long-turn-control");
      const longSession = await harness.api.createSession<Session>({
        experience: "development",
        provider: "openpond",
        modelRef,
        title: longTitle,
        cwd: workspace,
      });
      const controlSession = await harness.api.createSession<Session>({
        experience: "development",
        provider: "openpond",
        modelRef,
        title: controlTitle,
        cwd: workspace,
      });

      await reloadRenderer(harness);
      await selectWorkTaskMode(harness);
      await Promise.all([
        waitForSidebarSessionRow(harness, longSession.id),
        waitForSidebarSessionRow(harness, controlSession.id),
      ]);
      await harness.renderer.selectSession(longSession.id);

      const prompt = "Read the three deterministic large logs, survive automatic compaction, and finish the packaged proof.";
      const turnStartedAt = Date.now();
      await harness.renderer.submitComposer(prompt);

      const compaction = await harness.events.waitFor(
        (event) =>
          event.sessionId === longSession.id &&
          event.name === "session.compaction.completed" &&
          event.status === "completed" &&
          asRecord(event.data)?.reason === "auto" &&
          asRecord(event.data)?.roundIndex === 1,
        "automatic compaction after the three resource reads",
        { sessionId: longSession.id, timeoutMs: 180_000 },
      ) as RuntimeEvent;
      const compactionData = asRecord(compaction.data);
      const requestBudget = asRecord(compactionData?.requestBudget);

      const switchStartedAt = Date.now();
      await harness.renderer.selectSession(controlSession.id);
      await waitForRendererCondition(
        harness,
        `(() => {
          const selected = document.querySelector('[data-session-id].selected');
          const conversation = document.querySelector('.chat-thread[aria-label="Conversation"]');
          return selected?.getAttribute('data-session-id') === ${JSON.stringify(controlSession.id)} &&
            (!(conversation instanceof HTMLElement) || (
              !conversation.innerText.includes(${JSON.stringify(prompt)}) &&
              !conversation.innerText.includes(${JSON.stringify(finalMarker)})
            ));
        })()`,
        "isolated control transcript during resumed provider wait",
        { timeoutMs: 10_000 },
      );
      harness.recordAssertion("activeThreadStayedIsolated", true);

      await harness.renderer.selectSession(longSession.id);
      const switchRoundTripMs = Date.now() - switchStartedAt;
      const finalDelta = await waitForAssistantOutput(
        harness,
        longSession.id,
        finalMarker,
        "resumed post-compaction answer",
      );
      await waitForCompletedTurn(harness, longSession.id, finalDelta, "packaged long-turn completion");
      const completedInMs = Date.now() - turnStartedAt;

      await harness.renderer.assertText(prompt, { label: "long-turn user prompt" });
      await harness.renderer.assertText(/compacted context/i, { label: "automatic compaction status divider" });
      await harness.renderer.assertText(finalMarker, { label: "post-compaction final marker" });
      harness.recordAssertion("postCompactionAnswerVisible", true);

      const page = await harness.api.eventPage<RuntimeEventPage>({
        sessionId: longSession.id,
        afterSequence: 0,
        limit: 200,
      });
      const events = page.events.map((entry) => entry.event);
      const toolStarted = events.filter((event) => event.name === "tool.started" && event.action === "resource_read");
      const toolCompleted = events.filter((event) => event.name === "tool.completed" && event.action === "resource_read");
      const autoCompactions = events.filter((event) =>
        event.name === "session.compaction.completed" && asRecord(event.data)?.reason === "auto"
      );
      const turnCompleted = events.filter((event) => event.name === "turn.completed" && event.turnId === finalDelta.turnId);
      const failedOrInterrupted = events.filter((event) =>
        event.turnId === finalDelta.turnId && (event.name === "turn.failed" || event.name === "turn.interrupted")
      );
      const refs = toolStarted.map((event) => typeof event.args?.ref === "string" ? event.args.ref : null);
      if (toolStarted.length !== 3 || toolCompleted.length !== 3) {
        throw new Error(`Expected exactly three resource reads, saw ${toolStarted.length} starts and ${toolCompleted.length} completions.`);
      }
      if (new Set(refs).size !== 3 || refs.some((ref) => !ref?.startsWith("workspace:file:large-"))) {
        throw new Error(`Unexpected or duplicate resource refs: ${JSON.stringify(refs)}`);
      }
      if (autoCompactions.length !== 1) throw new Error(`Expected one automatic compaction, saw ${autoCompactions.length}.`);
      if (turnCompleted.length !== 1) throw new Error(`Expected one completed turn event, saw ${turnCompleted.length}.`);
      if (failedOrInterrupted.length > 0) throw new Error("The packaged long turn failed or was interrupted.");
      if ((requestBudget?.toolDefinitionTokens as number | undefined) === undefined ||
          Number(requestBudget?.toolDefinitionTokens) <= 0) {
        throw new Error("Automatic compaction did not record the physical request tool-definition budget.");
      }

      harness.recordAssertion("exactlyThreeResourceReads", true);
      harness.recordAssertion("exactlyOneAutomaticCompaction", true);
      harness.recordAssertion("exactlyOneCompletedTurn", true);
      harness.recordAssertion("noFailedOrInterruptedTurn", true);

      const usage = await harness.api.usageRecords<{ records?: Array<Record<string, unknown>> }>({
        range: "all",
        limit: 100,
      });
      const sessionUsage = (usage.records ?? []).filter((record) => record.sessionId === longSession.id);
      const chatUsage = sessionUsage.filter((record) => record.requestKind === "chat_turn");
      const toolLoopUsage = sessionUsage.filter((record) => record.requestKind === "tool_loop");
      const compactionUsage = sessionUsage.filter((record) => record.requestKind === "context_compaction");
      if (chatUsage.length !== 1 || toolLoopUsage.length !== 1 || compactionUsage.length !== 1) {
        throw new Error(
          `Unexpected usage records: ${chatUsage.length} chat turns, ${toolLoopUsage.length} tool loops, and ${compactionUsage.length} compactions.`,
        );
      }
      if (chatUsage[0]?.status !== "completed" || chatUsage[0]?.requestOrdinal !== 0) {
        throw new Error(`The initial physical provider attempt was not recorded correctly: ${JSON.stringify(chatUsage[0])}`);
      }
      if (toolLoopUsage[0]?.status !== "completed" || toolLoopUsage[0]?.requestOrdinal !== 1) {
        throw new Error(`The resumed physical provider attempt was not recorded correctly: ${JSON.stringify(toolLoopUsage[0])}`);
      }
      if (compactionUsage[0]?.status !== "completed") {
        throw new Error("The automatic compaction usage record did not complete.");
      }
      if ([...chatUsage, ...toolLoopUsage, ...compactionUsage].some(
        (record) => record.status === "failed" || record.status === "interrupted",
      )) {
        throw new Error("The packaged long turn recorded failed or interrupted model usage.");
      }
      harness.recordAssertion("resumedPhysicalProviderAttemptRecorded", true);
      harness.recordAssertion("contextCompactionUsageRecorded", true);

      const reloadStartedAt = Date.now();
      await reloadRenderer(harness);
      await selectWorkTaskMode(harness);
      await Promise.all([
        waitForSidebarSessionRow(harness, longSession.id),
        waitForSidebarSessionRow(harness, controlSession.id),
      ]);
      await harness.renderer.selectSession(longSession.id);
      await harness.renderer.assertText(prompt, { label: "reloaded long-turn prompt" });
      await harness.renderer.assertText(/compacted context/i, { label: "reloaded compaction divider" });
      await harness.renderer.assertText(finalMarker, { label: "reloaded post-compaction answer" });
      await waitForRendererCondition(
        harness,
        `document.querySelectorAll('[data-session-id].selected').length === 1`,
        "one selected thread after long-turn reload",
      );
      harness.recordAssertion("transcriptPersistedAfterReload", true);

      harness.recordMetadata({
        modelRef,
        longSessionId: longSession.id,
        controlSessionId: controlSession.id,
        turnId: finalDelta.turnId ?? null,
        compactionEventId: compaction.id,
        resourceRefs: refs,
        completedInMs,
        switchRoundTripMs,
        settledReloadMs: Date.now() - reloadStartedAt,
        requestBudget,
        usageCounts: {
          chatTurn: chatUsage.length,
          toolLoop: toolLoopUsage.length,
          contextCompaction: compactionUsage.length,
        },
      });
      await harness.screenshot("packaged-long-turn-compaction-complete");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
});

async function selectWorkTaskMode(harness: DesktopHarness): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const option = document.querySelector('.new-experience-option[data-experience="work"]');
      if (!(option instanceof HTMLButtonElement)) return false;
      option.click();
      return true;
    })()`,
    "Work task mode selector",
  );
}
