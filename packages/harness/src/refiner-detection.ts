import {
  createImprovementObservation,
  createRefinementTriggerDecision,
  type ImprovementObservation,
  type ImprovementSafeBoundary,
  type RefinementTriggerDecision,
  type RefinementTriggerPolicy,
} from "./harness-improvements.js";
import { contentHash, type ImmutableReleaseRef } from "./common.js";
import type { HarnessOverlaySnapshotRef } from "./harness-workspaces.js";

export type HarnessRefinerRuntimeEvent = {
  [key: string]: unknown;
  id: string;
  sequence?: number;
  timestamp: string;
  name: string;
  status?: string | null;
  action?: string | null;
  args?: unknown;
  data?: unknown;
  output?: string | null;
  error?: string | null;
};

export const DEFAULT_REFINEMENT_TRIGGER_POLICY: RefinementTriggerPolicy = {
  schemaVersion: "openpond.refinementTriggerPolicy.v1",
  maxEstimatedCostUsd: 0.05,
  cooldownMs: 0,
  maxPendingPlans: 2,
  maxEvidenceEvents: 20,
  maxProposalEdits: 4,
  maxProposalBytes: 20_000,
};

export type HarnessImprovementDetection = {
  observations: ImprovementObservation[];
  trigger: RefinementTriggerDecision;
};

type NormalizedToolOutcome = {
  event: HarnessRefinerRuntimeEvent;
  action: string;
  args: Record<string, unknown>;
  invocationKey: string;
  failed: boolean;
  deterministicClass: string | null;
};

export function detectHarnessImprovementAtBoundary(input: {
  runRef: string;
  turnId: string;
  harnessRelease: ImmutableReleaseRef;
  overlay: HarnessOverlaySnapshotRef | null;
  events: readonly HarnessRefinerRuntimeEvent[];
  boundary: ImprovementSafeBoundary;
  policy?: RefinementTriggerPolicy;
  pendingPlanCount?: number;
  priorDeduplicationKeys?: ReadonlySet<string>;
  cooldownUntil?: string | null;
  estimatedRefinerCostUsd?: number;
  loadedSkillNames?: readonly string[];
  turnReviewAlreadyQueued?: boolean;
}): HarnessImprovementDetection {
  const policy = input.policy ?? DEFAULT_REFINEMENT_TRIGGER_POLICY;
  const outcomes = normalizeToolOutcomes(input.events);
  const observations = collectObservations({ ...input, outcomes });
  const actionable = observations.filter(isActionableObservation);
  const deduplicationKey = contentHash({
    runRef: input.runRef,
    boundary: input.boundary.kind,
    observations: actionable.map((observation) => ({
      kind: observation.kind,
      deterministicClass: observation.deterministicClass,
      tool: observation.tool,
      state: observation.state,
      eventRefs: observation.eventRefs,
    })),
    turnId: input.turnId,
  });
  const base = {
    schemaVersion: "openpond.refinementTriggerDecision.v1" as const,
    id: stableId("refinement-trigger", {
      turnId: input.turnId,
      boundary: input.boundary,
      deduplicationKey,
      priorDeduplicationKeys: [...(input.priorDeduplicationKeys ?? [])].sort(),
      pendingPlanCount: input.pendingPlanCount ?? 0,
      cooldownUntil: input.cooldownUntil ?? null,
    }),
    runRef: input.runRef,
    turnId: input.turnId,
    harnessRelease: input.harnessRelease,
    overlay: input.overlay,
    observations: actionable
      .slice(0, policy.maxEvidenceEvents)
      .map((observation) => ({
        id: observation.id,
        contentHash: observation.contentHash,
      })),
    deduplicationKey,
    policy,
    pendingPlanCount: input.pendingPlanCount ?? 0,
    boundary: input.boundary,
    cooldownUntil: input.cooldownUntil ?? null,
    createdAt: input.boundary.occurredAt,
    metadata: {
      loadedSkillNames: [...new Set(input.loadedSkillNames ?? [])].sort(),
    },
  };

  if (actionable.length === 0) {
    return {
      observations,
      trigger: createRefinementTriggerDecision({
        ...base,
        observations: [],
        decision: "no_action",
        deterministicRoute: null,
        suggestedRoutes: [],
        reason: observations.some((observation) => observation.state === "open")
          ? "A tool failure is still open; wait for recovery or a terminal turn boundary."
          : "The completed boundary contains no new reviewable turn or reusable detour.",
        estimatedMaxCostUsd: 0,
      }),
    };
  }

  if (input.turnReviewAlreadyQueued) {
    return {
      observations,
      trigger: createRefinementTriggerDecision({
        ...base,
        decision: "no_action",
        deterministicRoute: null,
        suggestedRoutes: [],
        reason: "This turn already has a queued background Harness review.",
        estimatedMaxCostUsd: 0,
      }),
    };
  }

  if (input.priorDeduplicationKeys?.has(deduplicationKey)) {
    return {
      observations,
      trigger: createRefinementTriggerDecision({
        ...base,
        decision: "no_action",
        deterministicRoute: null,
        suggestedRoutes: [],
        reason: "Equivalent improvement evidence was already routed for this run.",
        estimatedMaxCostUsd: 0,
      }),
    };
  }

  if (isCoolingDown(input.boundary.occurredAt, input.cooldownUntil)) {
    return {
      observations,
      trigger: createRefinementTriggerDecision({
        ...base,
        decision: "no_action",
        deterministicRoute: null,
        suggestedRoutes: [],
        reason: "The Refiner is in its configured cooldown window.",
        estimatedMaxCostUsd: 0,
      }),
    };
  }

  if ((input.pendingPlanCount ?? 0) >= policy.maxPendingPlans) {
    return {
      observations,
      trigger: createRefinementTriggerDecision({
        ...base,
        decision: "no_action",
        deterministicRoute: null,
        suggestedRoutes: [],
        reason: "The run already has the maximum number of pending improvement plans.",
        estimatedMaxCostUsd: 0,
      }),
    };
  }

  const estimatedMaxCostUsd = input.estimatedRefinerCostUsd ?? 0.01;
  if (estimatedMaxCostUsd > policy.maxEstimatedCostUsd) {
    return {
      observations,
      trigger: createRefinementTriggerDecision({
        ...base,
        decision: "no_action",
        deterministicRoute: null,
        suggestedRoutes: [],
        reason: "The bounded Refiner estimate exceeds the configured run budget.",
        estimatedMaxCostUsd: 0,
      }),
    };
  }

  return {
    observations,
    trigger: createRefinementTriggerDecision({
      ...base,
      decision: "queue_refiner",
      deterministicRoute: null,
      suggestedRoutes: suggestedRoutesFor(actionable),
      reason: actionable.some((observation) => observation.kind === "user_turn")
        ? "A completed user turn is ready for bounded background Harness review."
        : "A recovered detour may contain a reusable Harness improvement.",
      estimatedMaxCostUsd,
    }),
  };
}

function collectObservations(input: {
  runRef: string;
  turnId: string;
  harnessRelease: ImmutableReleaseRef;
  overlay: HarnessOverlaySnapshotRef | null;
  outcomes: NormalizedToolOutcome[];
  boundary: ImprovementSafeBoundary;
  events: readonly HarnessRefinerRuntimeEvent[];
}): ImprovementObservation[] {
  const observations: ImprovementObservation[] = [];
  const openFailures: NormalizedToolOutcome[] = [];
  const seenFailureKeys = new Set<string>();
  const recoveredFailureKeys = new Set<string>();

  const userTurnEvent = input.boundary.kind === "turn_completed"
    ? latestUserTurnEvent(input.events)
    : null;
  if (userTurnEvent) {
    observations.push(
      observationForEvents({
        input,
        kind: "user_turn",
        state: "terminal",
        events: [userTurnEvent],
        deterministicClass: null,
        summary: "The completed user turn is available for bounded background review.",
      }),
    );
  }

  for (const outcome of input.outcomes) {
    if (outcome.action === "refine_request" && !outcome.failed) {
      const suggestedRoute = typeof outcome.args.suggestedRoute === "string"
        ? outcome.args.suggestedRoute
        : null;
      const requestedSummary = typeof outcome.args.summary === "string"
        ? outcome.args.summary.trim()
        : "The agent explicitly requested bounded refinement.";
      observations.push(
        observationFor({
          input,
          kind: "reusable_success",
          state: "terminal",
          outcomes: [outcome],
          deterministicClass: suggestedRoute
            ? `refine_requested_${suggestedRoute}`
            : "refine_requested",
          summary: requestedSummary.slice(0, 100_000),
        }),
      );
      continue;
    }
    if (outcome.failed) {
      const failureKey = contentHash({
        action: outcome.action,
        deterministicClass: outcome.deterministicClass,
        invocationKey: outcome.invocationKey,
      });
      if (!seenFailureKeys.has(failureKey)) {
        observations.push(
          observationFor({
            input,
            kind: "tool_failure",
            state: input.boundary.kind === "turn_completed" ? "terminal" : "open",
            outcomes: [outcome],
            deterministicClass: outcome.deterministicClass,
            summary: `Tool ${outcome.action} failed${
              outcome.deterministicClass ? ` (${outcome.deterministicClass})` : ""
            }.`,
          }),
        );
        seenFailureKeys.add(failureKey);
      }
      openFailures.push(outcome);
      continue;
    }

    const sameActionIndex = findLastIndex(
      openFailures,
      (candidate) => candidate.action === outcome.action,
    );
    const priorFailureIndex = sameActionIndex >= 0
      ? sameActionIndex
      : openFailures.length - 1;
    const priorFailure = openFailures[priorFailureIndex];
    if (!priorFailure) continue;
    const failureKey = contentHash({
      action: priorFailure.action,
      deterministicClass: priorFailure.deterministicClass,
      invocationKey: priorFailure.invocationKey,
    });
    if (recoveredFailureKeys.has(failureKey)) continue;

    const failureObservationIndex = observations.findIndex(
      (observation) =>
        observation.kind === "tool_failure" &&
        observation.eventRefs.some(
          (reference) => reference.id === priorFailure.event.id,
        ),
    );
    if (failureObservationIndex >= 0) {
      observations[failureObservationIndex] = observationFor({
        input,
        kind: "tool_failure",
        state: "recovered",
        outcomes: [priorFailure],
        deterministicClass: priorFailure.deterministicClass,
        summary: `Tool ${priorFailure.action} failed and recovered within the same run${
          priorFailure.deterministicClass
            ? ` (${priorFailure.deterministicClass})`
            : ""
        }.`,
      });
    }

    if (priorFailure.action === outcome.action) {
      observations.push(
        observationFor({
          input,
          kind: "retry",
          state: "recovered",
          outcomes: [priorFailure, outcome],
          deterministicClass: priorFailure.deterministicClass,
          summary: `Tool ${outcome.action} was retried after a failure.`,
        }),
      );
    }
    observations.push(
      observationFor({
        input,
        kind: "recovery",
        state: "recovered",
        outcomes: [priorFailure, outcome],
        deterministicClass: recoveredClass(priorFailure.deterministicClass),
        summary: priorFailure.action === outcome.action
          ? `Tool ${outcome.action} recovered within the same run.`
          : `Tool ${outcome.action} recovered after ${priorFailure.action} failed.`,
      }),
    );
    recoveredFailureKeys.add(failureKey);
    openFailures.splice(priorFailureIndex, 1);
  }

  const recovered = observations.filter((observation) => observation.kind === "recovery");
  if (input.boundary.kind === "turn_completed" && recovered.length > 0) {
    const relevantOutcomes = input.outcomes.filter((outcome) =>
      recovered.some((observation) =>
        observation.eventRefs.some((reference) => reference.id === outcome.event.id),
      ),
    );
    observations.push(
      observationFor({
        input,
        kind: "completion_detour",
        state: "recovered",
        outcomes: relevantOutcomes,
        deterministicClass: "completed_after_recovery",
        summary: "The turn completed after one or more recoverable tool detours.",
      }),
    );
  }
  return observations;
}

function observationForEvents(input: {
  input: {
    runRef: string;
    turnId: string;
    harnessRelease: ImmutableReleaseRef;
    overlay: HarnessOverlaySnapshotRef | null;
    boundary: ImprovementSafeBoundary;
  };
  kind: ImprovementObservation["kind"];
  state: ImprovementObservation["state"];
  events: HarnessRefinerRuntimeEvent[];
  deterministicClass: string | null;
  summary: string;
}): ImprovementObservation {
  const eventRefs = input.events.map((event) => ({
    id: event.id,
    sequence: event.sequence ?? null,
    contentHash: contentHash(event),
  }));
  return createImprovementObservation({
    schemaVersion: "openpond.improvementObservation.v1",
    id: stableId("improvement-observation", {
      runRef: input.input.runRef,
      kind: input.kind,
      state: input.state,
      deterministicClass: input.deterministicClass,
      summary: input.summary,
      eventRefs,
      boundary: input.input.boundary,
    }),
    runRef: input.input.runRef,
    turnId: input.input.turnId,
    harnessRelease: input.input.harnessRelease,
    overlay: input.input.overlay,
    eventRefs,
    kind: input.kind,
    state: input.state,
    tool: null,
    deterministicClass: input.deterministicClass,
    summary: input.summary,
    createdAt: input.input.boundary.occurredAt,
    metadata: {},
  });
}

function latestUserTurnEvent(events: readonly HarnessRefinerRuntimeEvent[]): HarnessRefinerRuntimeEvent | null {
  return [...events]
    .sort(compareEvents)
    .reverse()
    .find((event) => event.name === "turn.started") ?? null;
}

function findLastIndex<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) return index;
  }
  return -1;
}

function observationFor(input: {
  input: {
    runRef: string;
    turnId: string;
    harnessRelease: ImmutableReleaseRef;
    overlay: HarnessOverlaySnapshotRef | null;
    boundary: ImprovementSafeBoundary;
  };
  kind: ImprovementObservation["kind"];
  state: ImprovementObservation["state"];
  outcomes: NormalizedToolOutcome[];
  deterministicClass: string | null;
  summary: string;
}): ImprovementObservation {
  const eventRefs = input.outcomes.map(({ event }) => ({
    id: event.id,
    sequence: event.sequence ?? null,
    contentHash: contentHash(event),
  }));
  const first = input.outcomes[0] ?? null;
  return createImprovementObservation({
    schemaVersion: "openpond.improvementObservation.v1",
    id: stableId("improvement-observation", {
      runRef: input.input.runRef,
      kind: input.kind,
      state: input.state,
      deterministicClass: input.deterministicClass,
      summary: input.summary,
      eventRefs,
      boundary: input.input.boundary,
    }),
    runRef: input.input.runRef,
    turnId: input.input.turnId,
    harnessRelease: input.input.harnessRelease,
    overlay: input.input.overlay,
    eventRefs,
    kind: input.kind,
    state: input.state,
    tool: first
      ? { name: first.action, invocationKey: first.invocationKey }
      : null,
    deterministicClass: input.deterministicClass,
    summary: input.summary,
    createdAt: input.input.boundary.occurredAt,
    metadata: {},
  });
}

function normalizeToolOutcomes(events: readonly HarnessRefinerRuntimeEvent[]): NormalizedToolOutcome[] {
  const startedByCallId = new Map<string, HarnessRefinerRuntimeEvent>();
  const outcomes: NormalizedToolOutcome[] = [];
  for (const event of [...events].sort(compareEvents)) {
    const callId = toolCallId(event);
    if (event.name === "tool.started") {
      if (callId) startedByCallId.set(callId, event);
      continue;
    }
    // Workspace action results are implementation details nested beneath a
    // provider tool call. Treating cleanup/status actions as independent tool
    // successes can falsely mark the parent tool failure as recovered.
    if (event.name !== "tool.completed") continue;
    const action = toolAction(event);
    const started = callId ? startedByCallId.get(callId) : undefined;
    const failed = toolEventFailed(event);
    outcomes.push({
      event,
      action,
      args: asRecord(started?.args ?? event.args),
      invocationKey: contentHash({
        action,
        args: started?.args ?? event.args ?? {},
      }),
      failed,
      deterministicClass: failed ? classifyToolFailure(event) : null,
    });
  }
  return outcomes;
}

function toolEventFailed(event: HarnessRefinerRuntimeEvent): boolean {
  if (event.status === "failed") return true;
  const data = asRecord(event.data);
  const result = asRecord(data.result);
  if (result.ok === false) return true;
  const status = String(data.status ?? result.status ?? "").toLowerCase();
  return ["failed", "error", "errored", "blocked", "timed_out"].includes(status);
}

function classifyToolFailure(event: HarnessRefinerRuntimeEvent): string {
  const data = asRecord(event.data);
  const result = asRecord(data.result);
  if (result.timedOut === true) return "timeout";
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    return "command_exit_nonzero";
  }
  const structuredStatus = String(data.status ?? result.status ?? "").toLowerCase();
  if (["timed_out", "timeout"].includes(structuredStatus)) return "timeout";
  const text = [
    event.error,
    event.output,
    result.error,
    result.stderr,
    result.stdout,
  ].filter((value): value is string => typeof value === "string").join("\n").toLowerCase();
  if (
    text.includes("modulenotfounderror") ||
    text.includes("module_not_found") ||
    text.includes("cannot find module") ||
    text.includes("no module named")
  ) {
    return "dependency_missing";
  }
  if (text.includes("research limit") || text.includes("rate limit") || text.includes("quota")) {
    return "tool_budget_exhausted";
  }
  if (text.includes("permission denied") || text.includes("forbidden") || text.includes("unauthorized")) {
    return "permission_denied";
  }
  if (/\btimed out\b|\btimeout\b/.test(text)) return "timeout";
  if (
    text.includes("invalid argument") ||
    text.includes("invalid_request") ||
    text.includes("validation")
  ) {
    return "invalid_tool_arguments";
  }
  if (text.includes("enoent") || text.includes("no such file") || text.includes("not found")) {
    return "missing_file_or_resource";
  }
  if (text.includes("exit code") || text.includes("non-zero") || text.includes("nonzero")) {
    return "command_exit_nonzero";
  }
  return "unclassified_tool_failure";
}

function recoveredClass(deterministicClass: string | null): string {
  return deterministicClass ? `recovered_${deterministicClass}` : "recovered_tool_failure";
}

function isActionableObservation(observation: ImprovementObservation): boolean {
  return (
    observation.kind === "recovery" ||
    observation.kind === "completion_detour" ||
    observation.kind === "user_turn" ||
    observation.kind === "reusable_success" ||
    (observation.kind === "validation" && observation.state === "terminal") ||
    (observation.kind === "tool_failure" && observation.state === "terminal")
  );
}

function suggestedRoutesFor(
  observations: readonly ImprovementObservation[],
): Array<
  | "runtime"
  | "memory"
  | "prompt"
  | "skill"
  | "agent"
  | "product"
  | "taskset"
  | "training"
> {
  const explicitlySuggested = observations
    .map((observation) => /^refine_requested_(runtime|memory|prompt|skill|agent|product|taskset|training)$/.exec(
      observation.deterministicClass ?? "",
    )?.[1])
    .find((route): route is
      | "runtime"
      | "memory"
      | "prompt"
      | "skill"
      | "agent"
      | "product"
      | "taskset"
      | "training" => Boolean(route));
  if (explicitlySuggested) return [explicitlySuggested];
  if (observations.some((observation) => observation.kind === "user_turn")) {
    return [
      "runtime",
      "memory",
      "prompt",
      "skill",
      "agent",
      "product",
      "taskset",
      "training",
    ];
  }
  if (
    observations.some((observation) =>
      ["tool_budget_exhausted", "recovered_tool_budget_exhausted"].includes(
        observation.deterministicClass ?? "",
      ),
    )
  ) {
    return ["runtime", "skill"];
  }
  if (
    observations.some((observation) =>
      ["permission_denied", "recovered_permission_denied"].includes(
        observation.deterministicClass ?? "",
      ),
    )
  ) {
    return ["product", "runtime"];
  }
  return ["runtime", "skill", "prompt"];
}

function toolAction(event: HarnessRefinerRuntimeEvent): string {
  if (event.action?.trim()) return event.action.trim();
  const data = asRecord(event.data);
  return typeof data.tool === "string" && data.tool.trim() ? data.tool.trim() : "unknown_tool";
}

function toolCallId(event: HarnessRefinerRuntimeEvent): string | null {
  const data = asRecord(event.data);
  for (const value of [data.toolCallId, data.id, data.callId]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compareEvents(left: HarnessRefinerRuntimeEvent, right: HarnessRefinerRuntimeEvent): number {
  if (left.sequence !== undefined || right.sequence !== undefined) {
    return (left.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.sequence ?? Number.MAX_SAFE_INTEGER);
  }
  return left.timestamp.localeCompare(right.timestamp);
}

function isCoolingDown(now: string, cooldownUntil?: string | null): boolean {
  if (!cooldownUntil) return false;
  return Date.parse(now) < Date.parse(cooldownUntil);
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${contentHash(value).slice(0, 24)}`;
}
