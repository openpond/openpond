import {
  TrainingSourceRefSchema,
  createImprovementObservation,
  createImprovementRouteDecision,
  createRefinementTriggerDecision,
} from "@openpond/contracts";
import {
  contentHash,
  createHarnessEvaluationReviewReceipt,
} from "@openpond/evals";
import { describe, expect, it, vi } from "vitest";

import {
  harnessReviewLineageFromSources,
  linkHarnessReviewTaskset,
  startHarnessReviewTasksetAuthoring,
} from "./harness-review-taskset.js";

const NOW = "2026-08-08T16:00:00.000Z";
const harnessRelease = { id: "harness-release", contentHash: contentHash("harness-release") };
const policy = {
  policy: { id: "source-policy", contentHash: contentHash("source-policy") },
  state: "authorized" as const,
  checkedAt: NOW,
};

function fixture() {
  const observation = createImprovementObservation({
    schemaVersion: "openpond.improvementObservation.v1",
    id: "observation-one",
    runRef: "session-one",
    turnId: "turn-one",
    harnessRelease,
    overlay: null,
    eventRefs: [{ id: "event-one", sequence: 1, contentHash: contentHash("event-one") }],
    kind: "validation",
    state: "open",
    tool: null,
    deterministicClass: "behavior-gap",
    summary: "A repeatable behavior gap remained unresolved.",
    createdAt: NOW,
    metadata: {},
  });
  const trigger = createRefinementTriggerDecision({
    schemaVersion: "openpond.refinementTriggerDecision.v1",
    id: "trigger-one",
    runRef: observation.runRef,
    turnId: observation.turnId,
    harnessRelease,
    overlay: null,
    observations: [{ id: observation.id, contentHash: observation.contentHash }],
    decision: "route_deterministically",
    deterministicRoute: "taskset",
    suggestedRoutes: ["taskset"],
    reason: "The claim requires controlled Evaluation.",
    deduplicationKey: contentHash("behavior-gap"),
    policy: {
      schemaVersion: "openpond.refinementTriggerPolicy.v1",
      maxEstimatedCostUsd: 1,
      cooldownMs: 0,
      maxPendingPlans: 10,
      maxEvidenceEvents: 10,
      maxProposalEdits: 10,
      maxProposalBytes: 100_000,
    },
    estimatedMaxCostUsd: 0,
    pendingPlanCount: 0,
    boundary: { kind: "turn_completed", eventSequence: 1, occurredAt: NOW },
    cooldownUntil: null,
    createdAt: NOW,
    metadata: {},
  });
  const route = createImprovementRouteDecision({
    schemaVersion: "openpond.improvementRouteDecision.v1",
    id: "route-one",
    trigger: { id: trigger.id, contentHash: trigger.contentHash },
    route: "taskset",
    authority: "human_review",
    automatic: false,
    reason: "The claim requires controlled Evaluation.",
    createdAt: NOW,
    metadata: {},
  });
  const review = createHarnessEvaluationReviewReceipt({
    schemaVersion: "openpond.harnessEvaluationReviewReceipt.v1",
    id: "review-one",
    ownerScope: { kind: "personal", id: "desktop-personal" },
    workspaceRef: "workspace-one",
    harnessRelease,
    previousWatermark: null,
    nextWatermark: { cursor: contentHash("cursor"), throughCreatedAt: NOW },
    selectedEvidence: [{
      evidence: { id: route.id, contentHash: route.contentHash },
      kind: "route_decision",
      sourceRef: observation.runRef,
      sourcePolicy: policy,
      occurrenceKey: contentHash("occurrence-one"),
      occurredAt: NOW,
    }],
    excludedEvidence: [],
    claim: {
      fingerprint: contentHash("claim"),
      recurrenceFamily: "behavior-gap",
      statement: "Measure the unresolved behavior gap.",
      independentOccurrences: 1,
      unresolvedOccurrences: 1,
    },
    classification: "taskset",
    triage: [{
      layer: "evaluation",
      status: "unresolved",
      reason: "The claim requires controlled Evaluation.",
      evidenceRefs: [{ id: route.id, contentHash: route.contentHash }],
    }],
    reason: "The claim requires controlled Evaluation.",
    nextAuthority: "human_review",
    maxEstimatedCostUsd: 1,
    tasksetProposal: null,
    evaluation: null,
    trainingQualification: null,
    policyVersion: "review-policy-v1",
    createdAt: NOW,
    metadata: {},
  });
  const source = TrainingSourceRefSchema.parse({
    schemaVersion: "openpond.trainingSource.v1",
    id: "training-source-one",
    profileId: "default",
    sessionId: observation.runRef,
    turnIds: [observation.turnId],
    workspaceId: null,
    sourceHash: contentHash("training-source"),
    clusterKey: "session-one",
    title: "Source one",
    occurredAt: NOW,
    consent: {
      status: "granted",
      scope: "selected_turns",
      grantedBy: "local-user",
      grantedAt: NOW,
      purpose: "task_authoring_and_evaluation",
    },
    connectedAppIds: [],
    secretScanStatus: "passed",
    piiScanStatus: "passed",
    licensingStatus: "approved",
    metadata: {},
  });
  return { observation, trigger, route, review, source };
}

describe("Harness review Taskset bridge", () => {
  it("resolves exact review evidence into selected-turn Taskset authoring", async () => {
    const current = fixture();
    let persistedSource = current.source;
    const store = {
      getHarnessWorkspace: vi.fn(async () => ({
        id: "workspace-one",
        ownerScope: { kind: "personal", id: "desktop-personal" },
      })),
      listHarnessImprovementArtifacts: vi.fn(async (_workspaceId: string, kind: string) => ({
        evaluation_review: [current.review],
        route_decision: [current.route],
        trigger_decision: [current.trigger],
        observation: [current.observation],
      })[kind as "evaluation_review"] ?? []),
      listTaskCreationSnapshots: vi.fn(async () => []),
      upsertTrainingSource: vi.fn(async (source) => {
        persistedSource = source;
        return source;
      }),
    };
    const addSessionSource = vi.fn(async () => current.source);
    const startCreation = vi.fn(async (request) => ({ request }));

    const result = await startHarnessReviewTasksetAuthoring({
      store: store as never,
      taskCreator: { addSessionSource } as never,
      startCreation: startCreation as never,
      profileId: "default",
      workspaceId: "workspace-one",
      reviewRef: { id: current.review.id, contentHash: current.review.contentHash },
    });

    expect(addSessionSource).toHaveBeenCalledWith({
      profileId: "default",
      sessionId: "session-one",
      turnIds: ["turn-one"],
      consentScope: "selected_turns",
    });
    expect(startCreation).toHaveBeenCalledWith(expect.objectContaining({
      sourceIds: ["training-source-one"],
      surface: "task_candidate",
      mode: "customize",
      objective: "Measure the unresolved behavior gap.",
    }));
    expect(result).toEqual(expect.objectContaining({ request: expect.any(Object) }));
    expect(harnessReviewLineageFromSources([persistedSource])).toMatchObject({
      review: {
        id: current.review.id,
        contentHash: current.review.contentHash,
        workspaceId: "workspace-one",
      },
    });
  });

  it("persists an immutable forward link from review to materialized Taskset", async () => {
    const current = fixture();
    const source = {
      ...current.source,
      metadata: {
        harnessEvaluationReviews: [{
          id: current.review.id,
          contentHash: current.review.contentHash,
          workspaceId: "workspace-one",
          harnessRelease,
          claimFingerprint: current.review.claim?.fingerprint,
          evidenceRefs: [current.review.selectedEvidence[0]!.evidence],
          sourcePolicies: [policy],
        }],
      },
    };
    const lineage = harnessReviewLineageFromSources([source])!;
    const saved: unknown[] = [];
    const store = {
      listHarnessImprovementArtifacts: vi.fn(async () => [current.review]),
      saveHarnessImprovementArtifact: vi.fn(async (_workspaceId, _kind, receipt) => {
        saved.push(receipt);
        return receipt;
      }),
    };
    const linked = await linkHarnessReviewTaskset({
      store: store as never,
      taskset: {
        id: "taskset-one",
        revision: 1,
        contentHash: contentHash("taskset-one"),
        metadata: {
          harnessEvaluationReview: {
            id: current.review.id,
            contentHash: current.review.contentHash,
          },
          harnessEvaluationLineage: lineage,
        },
      } as never,
      now: () => "2026-08-08T16:01:00.000Z",
    });

    expect(linked).toMatchObject({
      classification: "taskset",
      tasksetProposal: { id: "taskset-one", contentHash: contentHash("taskset-one") },
      evaluation: null,
    });
    expect(saved).toHaveLength(1);
  });
});
