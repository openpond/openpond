import type {
  HarnessAdvanceReceipt,
  HarnessRefinerOutcome,
  HarnessWorkspace,
  ImprovementApplyReceipt,
  ImprovementObservation,
  RefinementTriggerDecision,
  RuntimeEvent,
  Turn,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";

import type { SqliteStore } from "../store/store.js";
import { inspectBoundedPdfArtifactDiagnostics } from "./local-harness-refiner-context.js";

export type LocalHarnessDeepReviewLimits = {
  maxPrecedingTurns: number;
  maxConversationChars: number;
  maxContextEvents: number;
  maxArtifactDiagnostics: number;
  maxLaterResults: number;
};

type SourcePolicy = {
  sourceRef: string;
  policy: { id: string; contentHash: string };
  state: "authorized" | "revoked" | "deleted" | "expired";
  checkedAt: string;
};

export function createLocalHarnessDeepReviewContextLoader(input: {
  store: SqliteStore;
  workspace: HarnessWorkspace;
  sourcePolicies: Map<string, SourcePolicy>;
  observations: ImprovementObservation[];
  triggers: RefinementTriggerDecision[];
  outcomes: HarnessRefinerOutcome[];
  applyReceipts: ImprovementApplyReceipt[];
  advanceReceipts: HarnessAdvanceReceipt[];
  limits: LocalHarnessDeepReviewLimits;
}) {
  const eventsBySource = new Map<string, RuntimeEvent[]>();
  const turnsBySource = new Map<string, Turn[]>();
  const diagnosticsBySource = new Map<
    string,
    Awaited<ReturnType<typeof inspectBoundedPdfArtifactDiagnostics>>
  >();
  const triggerByRef = new Map(
    input.triggers.map((trigger) => [artifactKey(trigger), trigger]),
  );
  const observationByRef = new Map(
    input.observations.map((observation) => [artifactKey(observation), observation]),
  );
  const outcomeByTrigger = new Map(
    input.outcomes.map((outcome) => [artifactKey(outcome.trigger), outcome]),
  );

  return async (observation: ImprovementObservation): Promise<Record<string, unknown>> => {
    const [events, turns, session] = await Promise.all([
      cachedEvents(observation.runRef),
      cachedTurns(observation.runRef),
      input.store.getSession(observation.runRef),
    ]);
    const orderedTurns = turns.slice().sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt),
    );
    const currentTurn = orderedTurns.find((turn) => turn.id === observation.turnId)
      ?? await input.store.getTurn(observation.turnId);
    const currentIndex = orderedTurns.findIndex((turn) => turn.id === observation.turnId);
    const allPreceding = currentIndex > 0 ? orderedTurns.slice(0, currentIndex) : [];
    const selectedPreceding = allPreceding.slice(-input.limits.maxPrecedingTurns);
    const precedingTurns = boundedConversationTurns(
      selectedPreceding,
      events,
      input.limits.maxConversationChars,
    );
    const turnEvents = events.filter((event) => event.turnId === observation.turnId);
    const relevantEvents = turnEvents
      .filter((event) => [
        "tool.completed",
        "validation.completed",
        "workspace_action_result",
      ].includes(event.name))
      .filter((event) =>
        event.status === "failed"
        || ["validation.completed", "workspace_action_result"].includes(event.name),
      );
    let artifactDiagnostics = diagnosticsBySource.get(observation.runRef);
    if (!artifactDiagnostics) {
      artifactDiagnostics = await inspectBoundedPdfArtifactDiagnostics(session?.cwd);
      diagnosticsBySource.set(observation.runRef, artifactDiagnostics);
    }
    const sourcePolicy = input.sourcePolicies.get(observation.runRef) ?? null;
    const currentOutcome = outcomeForObservation(observation);
    const laterResultSet = relatedLaterResults(observation);
    const laterResults = laterResultSet.results;
    const content = {
      schemaVersion: "openpond.localHarnessDeepReviewContext.v1" as const,
      binding: {
        ownerScope: input.workspace.ownerScope,
        workspaceId: input.workspace.id,
        sourceRef: observation.runRef,
        sourceTurn: observation.turnId,
        admittedHarness: observation.harnessRelease,
        observation: artifactRef(observation),
        refinerOutcome: currentOutcome ? artifactRef(currentOutcome) : null,
        sourcePolicy: sourcePolicy ? {
          policy: sourcePolicy.policy,
          state: sourcePolicy.state,
          checkedAt: sourcePolicy.checkedAt,
        } : null,
      },
      conversation: {
        precedingTurns,
        currentTurn: currentTurn ? boundedTurn(currentTurn, events, 2_000, 6_000) : null,
      },
      artifactDiagnostics: artifactDiagnostics.slice(0, input.limits.maxArtifactDiagnostics),
      events: relevantEvents.slice(-input.limits.maxContextEvents).map(boundedReviewEvent),
      currentResult: currentOutcome ? boundedOutcomeResult(currentOutcome) : null,
      laterResults,
      truncation: {
        availablePrecedingTurns: allPreceding.length,
        includedPrecedingTurns: precedingTurns.length,
        precedingTurnsTruncated: allPreceding.length > precedingTurns.length,
        conversationChars: conversationCharacterCount(precedingTurns),
        availableContextEvents: relevantEvents.length,
        includedContextEvents: Math.min(relevantEvents.length, input.limits.maxContextEvents),
        availableArtifactDiagnostics: artifactDiagnostics.length,
        includedArtifactDiagnostics: Math.min(
          artifactDiagnostics.length,
          input.limits.maxArtifactDiagnostics,
        ),
        availableLaterResults: laterResultSet.total,
        includedLaterResults: laterResults.length,
        laterResultsTruncated: laterResultSet.total > laterResults.length,
        sessionMissing: session === null,
        turnMissing: currentTurn === null,
      },
    };
    return { ...content, contentHash: contentHash(content) };
  };

  async function cachedEvents(sourceRef: string): Promise<RuntimeEvent[]> {
    const cached = eventsBySource.get(sourceRef);
    if (cached) return cached;
    const events = await input.store.runtimeEventsForSession(sourceRef);
    eventsBySource.set(sourceRef, events);
    return events;
  }

  async function cachedTurns(sourceRef: string): Promise<Turn[]> {
    const cached = turnsBySource.get(sourceRef);
    if (cached) return cached;
    const turns = await input.store.turnsForSession(sourceRef, 500);
    turnsBySource.set(sourceRef, turns);
    return turns;
  }

  function outcomeForObservation(
    observation: ImprovementObservation,
  ): HarnessRefinerOutcome | null {
    for (const trigger of input.triggers) {
      if (!trigger.observations.some((ref) => artifactKey(ref) === artifactKey(observation))) {
        continue;
      }
      return outcomeByTrigger.get(artifactKey(trigger)) ?? null;
    }
    return null;
  }

  function relatedLaterResults(
    observation: ImprovementObservation,
  ): { results: Array<Record<string, unknown>>; total: number } {
    if (!observation.deterministicClass) return { results: [], total: 0 };
    const related = input.outcomes.flatMap((outcome) => {
      if (outcome.createdAt <= observation.createdAt) return [];
      const trigger = triggerByRef.get(artifactKey(outcome.trigger));
      const linked = trigger?.observations
        .map((ref) => observationByRef.get(artifactKey(ref)))
        .filter((candidate): candidate is ImprovementObservation => Boolean(candidate))
        ?? [];
      if (!linked.some((candidate) =>
        candidate.deterministicClass === observation.deterministicClass,
      )) return [];
      return [boundedOutcomeResult(outcome)];
    });
    const sorted = related
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    return {
      results: sorted.slice(0, input.limits.maxLaterResults),
      total: sorted.length,
    };
  }

  function boundedOutcomeResult(outcome: HarnessRefinerOutcome): Record<string, unknown> {
    const applies = outcome.proposal
      ? input.applyReceipts.filter((receipt) =>
          artifactKey(receipt.proposal) === artifactKey(outcome.proposal!),
        )
      : [];
    const advances = outcome.proposal
      ? input.advanceReceipts.filter((receipt) =>
          receipt.proposal && artifactKey(receipt.proposal) === artifactKey(outcome.proposal!),
        )
      : [];
    const relatedAdvanceRefs = new Set(advances.map((receipt) => artifactKey(receipt)));
    const rollbacks = input.advanceReceipts.filter((receipt) =>
      receipt.rollbackOf && relatedAdvanceRefs.has(artifactKey(receipt.rollbackOf)),
    );
    return {
      outcome: artifactRef(outcome),
      decision: outcome.decision,
      reason: boundedReviewText(outcome.reason, 1_500),
      proposal: outcome.proposal,
      createdAt: outcome.createdAt,
      applyReceipts: applies.map((receipt) => ({
        ...artifactRef(receipt),
        decision: receipt.decision,
        createdAt: receipt.createdAt,
      })),
      advanceReceipts: advances.map((receipt) => ({
        ...artifactRef(receipt),
        decision: receipt.decision,
        previousRelease: receipt.previousRelease,
        nextRelease: receipt.nextRelease,
        createdAt: receipt.createdAt,
      })),
      rollbackReceipts: rollbacks.map((receipt) => ({
        ...artifactRef(receipt),
        decision: receipt.decision,
        rollbackOf: receipt.rollbackOf,
        nextRelease: receipt.nextRelease,
        createdAt: receipt.createdAt,
      })),
    };
  }
}

function boundedConversationTurns(
  turns: Turn[],
  events: RuntimeEvent[],
  maxCharacters: number,
): Array<Record<string, unknown>> {
  if (!turns.length || maxCharacters <= 0) return [];
  const perField = Math.max(1, Math.floor(maxCharacters / (turns.length * 2)));
  return turns.map((turn) => boundedTurn(turn, events, perField, perField));
}

function boundedTurn(
  turn: Turn,
  events: RuntimeEvent[],
  promptLimit: number,
  outputLimit: number,
): Record<string, unknown> {
  return {
    id: turn.id,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    status: turn.status,
    error: boundedReviewText(turn.error ?? "", 1_000),
    prompt: boundedReviewText(turn.prompt, promptLimit),
    assistantOutput: boundedReviewText(assistantOutputForTurn(events, turn.id), outputLimit),
  };
}

function assistantOutputForTurn(events: RuntimeEvent[], turnId: string): string {
  return events
    .filter((event) => event.turnId === turnId && event.name === "assistant.delta")
    .map((event) => event.output ?? "")
    .join("");
}

function conversationCharacterCount(turns: Array<Record<string, unknown>>): number {
  return turns.reduce((total, turn) =>
    total
    + (typeof turn.prompt === "string" ? turn.prompt.length : 0)
    + (typeof turn.assistantOutput === "string" ? turn.assistantOutput.length : 0), 0);
}

function boundedReviewEvent(event: RuntimeEvent): Record<string, unknown> {
  const data = asRecord(event.data);
  const result = asRecord(data.result);
  return {
    id: event.id,
    name: event.name,
    action: event.action ?? (typeof data.tool === "string" ? data.tool : null),
    status: event.status ?? null,
    error: boundedReviewText(event.error ?? "", 750),
    output: boundedReviewText(
      typeof result.output === "string" ? result.output : event.output ?? "",
      750,
    ),
    stderr: boundedReviewText(typeof result.stderr === "string" ? result.stderr : "", 750),
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    timedOut: result.timedOut === true,
  };
}

function boundedReviewText(value: string, maxLength: number): string | null {
  if (!value || maxLength <= 0) return null;
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)(\s*[:=]\s*)([^\s,;]+)/gi,
      "$1$2[redacted]",
    );
  if (redacted.length <= maxLength) return redacted;
  const marker = "\n[... middle omitted ...]\n";
  if (marker.length >= maxLength) return redacted.slice(0, maxLength);
  const available = Math.max(0, maxLength - marker.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${redacted.slice(0, headLength)}${marker}${redacted.slice(-tailLength)}`;
}

function artifactRef(artifact: { id: string; contentHash: string }) {
  return { id: artifact.id, contentHash: artifact.contentHash };
}

function artifactKey(artifact: { id: string; contentHash: string }): string {
  return `${artifact.id}:${artifact.contentHash}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
