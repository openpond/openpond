import { describe, expect, test } from "vitest";

import {
  ImprovementApplyReceiptSchema,
  ImprovementObservationSchema,
  ImprovementRouteDecisionSchema,
  RefinementTriggerDecisionSchema,
  createImprovementApplyReceipt,
  createImprovementObservation,
  createImprovementRouteDecision,
  createRefinementTriggerDecision,
} from "@openpond/contracts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const CREATED_AT = "2026-08-05T12:00:00.000Z";

const harnessRelease = { id: "harness-release-a", contentHash: HASH_A };
const overlay = { id: "overlay-a", revision: 0, contentHash: HASH_B };
const boundary = {
  kind: "completed_tool_batch" as const,
  eventSequence: 12,
  occurredAt: CREATED_AT,
};
const policy = {
  schemaVersion: "openpond.refinementTriggerPolicy.v1" as const,
  maxEstimatedCostUsd: 0.05,
  cooldownMs: 60_000,
  maxPendingPlans: 2,
  maxEvidenceEvents: 20,
  maxProposalEdits: 4,
  maxProposalBytes: 20_000,
};

function toolFailureObservation() {
  return createImprovementObservation({
    schemaVersion: "openpond.improvementObservation.v1",
    id: "observation-a",
    runRef: "run-a",
    turnId: "turn-a",
    harnessRelease,
    overlay,
    eventRefs: [{ id: "event-a", sequence: 12, contentHash: HASH_C }],
    kind: "tool_failure",
    state: "open",
    tool: { name: "exec_command", invocationKey: HASH_C },
    deterministicClass: "dependency_missing",
    summary: "The document generator dependency was unavailable.",
    createdAt: CREATED_AT,
    metadata: {},
  });
}

describe("Harness improvement contracts", () => {
  test("hashes an exact observation and requires tool identity for tool failures", () => {
    const observation = toolFailureObservation();
    expect(ImprovementObservationSchema.parse(observation)).toEqual(observation);
    expect(observation.contentHash).toHaveLength(64);
    const { contentHash: _contentHash, ...observationContent } = observation;

    expect(() =>
      createImprovementObservation({
        ...observationContent,
        tool: null,
      }),
    ).toThrow(/require a tool identity/i);
  });

  test("creates bounded no-action and queued-Refiner decisions", () => {
    const observation = toolFailureObservation();
    const queued = createRefinementTriggerDecision({
      schemaVersion: "openpond.refinementTriggerDecision.v1",
      id: "trigger-a",
      runRef: "run-a",
      turnId: "turn-a",
      harnessRelease,
      overlay,
      observations: [{ id: observation.id, contentHash: observation.contentHash }],
      decision: "queue_refiner",
      deterministicRoute: null,
      suggestedRoutes: ["skill", "runtime"],
      reason: "A recovered dependency failure may be reusable.",
      deduplicationKey: HASH_C,
      policy,
      estimatedMaxCostUsd: 0.01,
      pendingPlanCount: 0,
      boundary,
      cooldownUntil: null,
      createdAt: CREATED_AT,
      metadata: {},
    });
    expect(RefinementTriggerDecisionSchema.parse(queued)).toEqual(queued);
    const { contentHash: _contentHash, ...queuedContent } = queued;

    const noAction = createRefinementTriggerDecision({
      ...queuedContent,
      id: "trigger-no-action",
      observations: [],
      decision: "no_action",
      suggestedRoutes: [],
      reason: "The successful tool batch contains no reusable detour.",
      estimatedMaxCostUsd: 0,
    });
    expect(noAction.decision).toBe("no_action");
  });

  test("rejects trigger decisions that exceed budget or omit deterministic routing", () => {
    const observation = toolFailureObservation();
    const base = {
      schemaVersion: "openpond.refinementTriggerDecision.v1" as const,
      id: "trigger-a",
      runRef: "run-a",
      turnId: "turn-a",
      harnessRelease,
      overlay,
      observations: [{ id: observation.id, contentHash: observation.contentHash }],
      decision: "queue_refiner" as const,
      deterministicRoute: null,
      suggestedRoutes: ["runtime" as const],
      reason: "A reusable failure was detected.",
      deduplicationKey: HASH_C,
      policy,
      estimatedMaxCostUsd: 0.01,
      pendingPlanCount: 0,
      boundary,
      cooldownUntil: null,
      createdAt: CREATED_AT,
      metadata: {},
    };
    expect(() =>
      createRefinementTriggerDecision({ ...base, estimatedMaxCostUsd: 0.1 }),
    ).toThrow(/exceeds the trigger policy budget/i);
    expect(() =>
      createRefinementTriggerDecision({
        ...base,
        decision: "route_deterministically",
      }),
    ).toThrow(/require a route/i);
  });

  test("keeps training routes under training-system authority", () => {
    const trigger = { id: "trigger-a", contentHash: HASH_A };
    expect(() =>
      createImprovementRouteDecision({
        schemaVersion: "openpond.improvementRouteDecision.v1",
        id: "route-a",
        trigger,
        route: "training",
        authority: "refiner_model",
        automatic: false,
        reason: "A model gap may remain.",
        createdAt: CREATED_AT,
        metadata: {},
      }),
    ).toThrow(/training-system authority/i);

    const decision = createImprovementRouteDecision({
      schemaVersion: "openpond.improvementRouteDecision.v1",
      id: "route-b",
      trigger,
      route: "runtime",
      authority: "runtime_service",
      automatic: true,
      reason: "A dependency declaration can be repaired deterministically.",
      createdAt: CREATED_AT,
      metadata: {},
    });
    expect(ImprovementRouteDecisionSchema.parse(decision)).toEqual(decision);
  });

  test("binds apply and rollback receipts to safe boundaries", () => {
    const applied = createImprovementApplyReceipt({
      schemaVersion: "openpond.improvementApplyReceipt.v1",
      id: "apply-a",
      proposal: { id: "proposal-a", contentHash: HASH_A },
      beforeOverlay: overlay,
      afterOverlay: { id: "overlay-a", revision: 1, contentHash: HASH_C },
      decision: "applied",
      boundary,
      validationRefs: [],
      outcomeEvidenceRefs: [],
      rollbackOf: null,
      createdAt: CREATED_AT,
      metadata: {},
    });
    expect(ImprovementApplyReceiptSchema.parse(applied)).toEqual(applied);
    const { contentHash: _contentHash, ...appliedContent } = applied;

    expect(() =>
      createImprovementApplyReceipt({
        ...appliedContent,
        decision: "retained",
      }),
    ).toThrow(/after-overlay/i);
  });
});
