import type { BootstrapPayload, RuntimeEvent, Session, Turn } from "@openpond/contracts";

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
  modelId: "openpond-scripted-subagent-review-revision",
};

export default desktopScenario({
  name: "subagent-review-revision-loop",
  mode: "isolated",
  timeoutMs: 180_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);
    await configureResearchSubagentModel(harness, modelRef, { heartbeatIntervalSeconds: 10 });

    const title = harness.uniqueTitle("subagent-review-revision-loop");
    const goal = {
      id: `goal_${Date.now().toString(36)}`,
      provider: "openpond",
      objective: "Prove parent review revision loop for a required subagent.",
      status: "running",
      timeUsedSeconds: 4,
      tokensUsed: 256,
      tokenBudget: 4096,
    };
    const session = await harness.api.createSession<Session>({
      provider: "openpond",
      modelRef,
      title,
      cwd: harness.repoRoot,
    });

    await reloadRenderer(harness);
    await harness.renderer.selectSession(session.id);
    await harness.renderer.assertText(title, { label: "review revision parent session title" });
    harness.recordMetadata({
      parentSessionId: session.id,
      title,
      modelRef,
      goalId: goal.id,
    });

    await harness.api.createTurn(session.id, {
      prompt: "Start a required child, request revision on the first packet, then accept the revised packet.",
      modelRef,
      metadata: { threadGoal: goal },
    });

    const startEvent = await harness.events.waitForToolCompleted(
      session.id,
      "openpond_subagent_start",
    ) as RuntimeEvent;
    const startResult = toolResultFromEvent(startEvent);
    const runId = stringFromRecord(startResult, "runId");
    const childSessionId = stringFromRecord(startResult, "childSessionId");
    if (!runId) throw new Error("openpond_subagent_start did not return a runId.");
    if (!childSessionId) throw new Error("openpond_subagent_start did not return a childSessionId.");
    await waitForCompletedTurn(harness, session.id, startEvent, "review loop initial parent turn completion");

    const initialSubmitted = await waitForSubagentEventAfter(harness, {
      sessionId: session.id,
      runId,
      eventName: "subagent.submitted",
      afterSequence: sequenceOf(startEvent),
      status: "submitted_for_review",
      label: "initial child submission",
    });
    const firstWake = await waitForWatcherWakeAfter(harness, {
      sessionId: session.id,
      runId,
      afterSequence: sequenceOf(initialSubmitted),
      reason: "required_submitted_for_review",
      label: "initial submitted watcher wake",
    });
    const revisionTool = await waitForReviewToolResultAfter(harness, {
      sessionId: session.id,
      runId,
      afterSequence: sequenceOf(firstWake),
      status: "needs_revision",
      label: "needs revision review tool",
    });
    await waitForCompletedTurn(harness, session.id, revisionTool, "needs revision parent turn completion");
    const needsRevisionEvent = await waitForSubagentEventAfter(harness, {
      sessionId: session.id,
      runId,
      eventName: "subagent.needs_revision",
      afterSequence: sequenceOf(initialSubmitted),
      status: "needs_revision",
      label: "needs revision receipt",
    });
    await waitForChildCorrectionMessage(harness, childSessionId, runId, sequenceOf(firstWake));
    harness.recordAssertion("parentRequestedRevision", true);
    harness.recordAssertion("revisionCorrectionDeliveredToChild", true);

    const childFollowUp = await harness.api.createTurn<Turn>(childSessionId, {
      prompt: "Continue after parent review and submit the revised packet.",
      modelRef,
    });
    const revisedSubmitted = await waitForSubagentEventAfter(harness, {
      sessionId: session.id,
      runId,
      eventName: "subagent.submitted",
      afterSequence: sequenceOf(needsRevisionEvent),
      status: "submitted_for_review",
      label: "revised child submission",
    });
    await waitForTurnCompleted(harness, childSessionId, childFollowUp.id, "revised child follow-up completion");
    await waitForAssistantOutput(
      harness,
      childSessionId,
      "Research subagent submitted the revised review packet with the requested regression proof.",
      "revised child packet output",
    );
    harness.recordAssertion("revisedChildPacketOutputRecorded", true);

    const secondWake = await waitForWatcherWakeAfter(harness, {
      sessionId: session.id,
      runId,
      afterSequence: sequenceOf(revisedSubmitted),
      reason: "required_submitted_for_review",
      label: "revised submitted watcher wake",
    });
    const acceptedTool = await waitForReviewToolResultAfter(harness, {
      sessionId: session.id,
      runId,
      afterSequence: sequenceOf(secondWake),
      status: "accepted",
      label: "accepted review tool",
    });
    await waitForCompletedTurn(harness, session.id, acceptedTool, "accepted parent turn completion");
    const acceptedEvent = await waitForSubagentEventAfter(harness, {
      sessionId: session.id,
      runId,
      eventName: "subagent.accepted",
      afterSequence: sequenceOf(revisedSubmitted),
      status: "accepted",
      label: "accepted receipt",
    });

    await harness.renderer.selectSession(session.id, { timeoutMs: 10_000 });
    await harness.renderer.assertText("Subagent needs revision", {
      label: "needs revision parent activity visible",
      timeoutMs: 10_000,
    });
    await harness.renderer.assertText("Subagent accepted", {
      label: "accepted parent activity visible",
      timeoutMs: 10_000,
    });
    harness.recordAssertion("parentReviewActivitiesVisible", true);

    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    const sessionEvents = bootstrap.events.filter((event) => event.sessionId === session.id);
    const reviewEvents = sessionEvents.filter((event) =>
      event.name === "tool.completed" &&
      event.action === "openpond_subagent_review"
    );
    const submittedEvents = sessionEvents.filter((event) =>
      event.name === "subagent.submitted" &&
      stringFromRecord(asRecord(asRecord(event.data)?.run), "id") === runId
    );
    if (reviewEvents.length !== 2) {
      throw new Error(`Expected exactly two parent review tool events, found ${reviewEvents.length}.`);
    }
    if (submittedEvents.length !== 2) {
      throw new Error(`Expected exactly two submitted receipts, found ${submittedEvents.length}.`);
    }
    harness.recordAssertion("exactlyTwoReviewDecisions", true);
    harness.recordAssertion("exactlyTwoSubmissionReceipts", true);
    harness.recordMetadata({
      runId,
      childSessionId,
      parentTurnId: startEvent.turnId ?? null,
      childFollowUpTurnId: childFollowUp.id,
      initialSubmittedEventId: initialSubmitted.id ?? null,
      needsRevisionEventId: needsRevisionEvent.id ?? null,
      revisedSubmittedEventId: revisedSubmitted.id ?? null,
      acceptedEventId: acceptedEvent.id ?? null,
      firstWakeDiagnosticId: firstWake.id ?? null,
      secondWakeDiagnosticId: secondWake.id ?? null,
      runtimeEventCount: sessionEvents.length,
    });

    await harness.renderer.selectSession(session.id, { timeoutMs: 10_000 });
    await harness.screenshot("subagent-review-revision-loop-complete");
  },
});

async function waitForSubagentEventAfter(
  harness: DesktopHarness,
  input: {
    sessionId: string;
    runId: string;
    eventName: "subagent.submitted" | "subagent.needs_revision" | "subagent.accepted";
    afterSequence: number;
    status: string;
    label: string;
  },
): Promise<RuntimeEvent> {
  return await harness.events.waitFor(
    (event) => {
      if (event.sessionId !== input.sessionId || event.name !== input.eventName) return false;
      if (sequenceOf(event) <= input.afterSequence) return false;
      const run = asRecord(asRecord(event.data)?.run);
      return stringFromRecord(run, "id") === input.runId &&
        stringFromRecord(run, "status") === input.status;
    },
    `${input.label}:${input.runId}`,
    { sessionId: input.sessionId, timeoutMs: 60_000 },
  ) as RuntimeEvent;
}

async function waitForWatcherWakeAfter(
  harness: DesktopHarness,
  input: {
    sessionId: string;
    runId: string;
    afterSequence: number;
    reason: string;
    label: string;
  },
): Promise<RuntimeEvent> {
  return await harness.events.waitFor(
    (event) => {
      if (event.sessionId !== input.sessionId || event.name !== "diagnostic") return false;
      if (sequenceOf(event) <= input.afterSequence) return false;
      const data = asRecord(event.data);
      const runIds = Array.isArray(data?.runIds) ? data.runIds : [];
      const reasons = Array.isArray(data?.reasons) ? data.reasons : [];
      return data?.kind === "subagent_lifecycle_watcher_wake" &&
        data.wakeQueued === true &&
        runIds.includes(input.runId) &&
        reasons.includes(input.reason);
    },
    `${input.label}:${input.runId}`,
    { sessionId: input.sessionId, timeoutMs: 60_000 },
  ) as RuntimeEvent;
}

async function waitForReviewToolResultAfter(
  harness: DesktopHarness,
  input: {
    sessionId: string;
    runId: string;
    afterSequence: number;
    status: "needs_revision" | "accepted";
    label: string;
  },
): Promise<RuntimeEvent> {
  return await harness.events.waitFor(
    (event) => {
      if (event.sessionId !== input.sessionId || event.name !== "tool.completed") return false;
      if (event.action !== "openpond_subagent_review" || sequenceOf(event) <= input.afterSequence) return false;
      const result = asRecord(asRecord(event.data)?.result);
      return stringFromRecord(result, "runId") === input.runId &&
        stringFromRecord(result, "status") === input.status;
    },
    `${input.label}:${input.runId}`,
    { sessionId: input.sessionId, timeoutMs: 60_000 },
  ) as RuntimeEvent;
}

async function waitForChildCorrectionMessage(
  harness: DesktopHarness,
  childSessionId: string,
  runId: string,
  afterSequence: number,
): Promise<RuntimeEvent> {
  return await harness.events.waitFor(
    (event) => {
      if (event.sessionId !== childSessionId || event.name !== "subagent.message") return false;
      if (sequenceOf(event) <= afterSequence) return false;
      const data = asRecord(event.data);
      return stringFromRecord(data, "deliveredToRunId") === runId &&
        stringFromRecord(data, "priority") === "interrupt";
    },
    `child correction message:${runId}`,
    { sessionId: childSessionId, timeoutMs: 30_000 },
  ) as RuntimeEvent;
}

function sequenceOf(event: RuntimeEvent): number {
  return typeof event.sequence === "number" ? event.sequence : 0;
}

async function waitForTurnCompleted(
  harness: DesktopHarness,
  sessionId: string,
  turnId: string,
  label: string,
): Promise<RuntimeEvent> {
  return await harness.events.waitFor(
    (event) =>
      event.sessionId === sessionId &&
      event.turnId === turnId &&
      event.name === "turn.completed" &&
      event.status === "completed",
    label,
    { sessionId, timeoutMs: 60_000 },
  ) as RuntimeEvent;
}
