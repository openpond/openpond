import type { BootstrapPayload, RuntimeEvent, Session } from "@openpond/contracts";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import {
  asRecord,
  configureResearchSubagentModel,
  registerScriptedOpenPondModel,
  reloadRenderer,
  stringFromRecord,
  toolResultFromEvent,
  waitForAssistantOutput,
  waitForCompletedTurn,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "openpond-scripted-subagent-progress-only",
};

export default desktopScenario({
  name: "subagent-heartbeat-no-progress-wake",
  mode: "isolated",
  timeoutMs: 150_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);
    await configureResearchSubagentModel(harness, modelRef, { heartbeatIntervalSeconds: 10 });

    const title = harness.uniqueTitle("subagent-heartbeat-no-progress-wake");
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
    await harness.renderer.assertText(title, { label: "progress-only parent session title" });

    await harness.renderer.submitComposer("Start the long-running child and prove routine heartbeat progress does not wake this parent.");
    const startEvent = await harness.events.waitForToolCompleted(
      session.id,
      "openpond_subagent_start",
    ) as RuntimeEvent;
    const startResult = toolResultFromEvent(startEvent);
    const runId = stringFromRecord(startResult, "runId");
    const childSessionId = stringFromRecord(startResult, "childSessionId");
    if (!runId) throw new Error("openpond_subagent_start did not return a runId.");
    if (!childSessionId) throw new Error("openpond_subagent_start did not return a childSessionId.");

    await waitForCompletedTurn(harness, session.id, startEvent, "progress-only parent start turn completion");
    await harness.renderer.assertText(`Research subagent progress-only child started for ${runId}.`, {
      label: "progress-only parent idle response",
    });
    await harness.renderer.assertText("Subagent running", {
      label: "progress-only running activity",
      timeoutMs: 10_000,
    });
    harness.recordAssertion("progressOnlyChildRunningVisible", true);

    const intervalTick = await waitForRoutineIntervalTick(harness, session.id, runId);
    const tickSequence = numberFromUnknown(intervalTick.sequence);
    const bootstrapAtTick = await harness.api.bootstrap<BootstrapPayload>();
    const eventsThroughTick = bootstrapAtTick.events.filter((event) =>
      event.sessionId === session.id &&
      numberFromUnknown(event.sequence) <= tickSequence
    );
    const wakeBeforeTick = eventsThroughTick.filter((event) =>
      event.name === "diagnostic" &&
      asRecord(event.data)?.kind === "subagent_lifecycle_watcher_wake"
    );
    const submittedBeforeTick = eventsThroughTick.some((event) =>
      event.name === "subagent.submitted" &&
      stringFromRecord(asRecord(asRecord(event.data)?.run), "id") === runId
    );
    const lifecycleWakeTextBeforeTick = eventsThroughTick.some((event) =>
      event.name === "assistant.delta" &&
      typeof event.output === "string" &&
      event.output.includes(`Watcher lifecycle review wake received for ${runId}.`)
    );
    if (wakeBeforeTick.length > 0) {
      throw new Error(`Expected no watcher wake before the routine interval tick, found ${wakeBeforeTick.length}.`);
    }
    if (submittedBeforeTick) {
      throw new Error("Child submitted before the routine interval no-wake proof completed.");
    }
    if (lifecycleWakeTextBeforeTick) {
      throw new Error("Parent model woke before a meaningful child lifecycle event.");
    }
    harness.recordAssertion("routineIntervalDidNotWakeParent", true);
    harness.recordAssertion("progressOnlyTickBeforeSubmission", true);
    await harness.screenshot("subagent-heartbeat-no-progress-wake-active");

    await harness.events.waitForSubagentSubmitted(session.id, runId);
    const assistantWake = await waitForAssistantOutput(
      harness,
      session.id,
      `Watcher lifecycle review wake received for ${runId}.`,
      "progress-only submitted lifecycle wake",
    );
    await waitForCompletedTurn(harness, session.id, assistantWake, "progress-only submitted lifecycle wake completion");
    await harness.renderer.assertText(`Watcher lifecycle review wake received for ${runId}.`, {
      label: "progress-only meaningful wake visible",
    });
    harness.recordAssertion("submittedLifecycleWakeStillWorks", true);

    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    harness.recordMetadata({
      runId,
      childSessionId,
      parentTurnId: startEvent.turnId ?? null,
      routineTickId: intervalTick.id ?? null,
      routineTickSequence: tickSequence,
      runtimeEventCount: bootstrap.events.filter((event) => event.sessionId === session.id).length,
    });
    await harness.screenshot("subagent-heartbeat-no-progress-wake-complete");
  },
});

async function waitForRoutineIntervalTick(
  harness: DesktopHarness,
  sessionId: string,
  runId: string,
): Promise<RuntimeEvent> {
  return await harness.events.waitFor(
    (event) => {
      if (event.sessionId !== sessionId || event.name !== "diagnostic") return false;
      const data = asRecord(event.data);
      const activeRunIds = Array.isArray(data?.activeRunIds) ? data.activeRunIds : [];
      return data?.kind === "subagent_lifecycle_watcher_tick" &&
        data.reason === "interval" &&
        data.wakeQueued === false &&
        data.wakePolicy === "not_waking_parent_for_routine_tick" &&
        data.staleCount === 0 &&
        activeRunIds.includes(runId);
    },
    `routine interval watcher tick without parent wake:${runId}`,
    { sessionId, timeoutMs: 30_000 },
  ) as RuntimeEvent;
}

function numberFromUnknown(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}
