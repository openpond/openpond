import { TasksetSchema } from "@openpond/contracts";
import {
  aggregateEvaluationReceipts,
  createAttemptReceipt,
} from "@openpond/evals";
import { genericToolConformance } from "@openpond/evals/conformance";
import {
  contentHash,
  createHarnessEvaluationReviewReceipt,
} from "@openpond/harness";
import { computeTasksetHash } from "@openpond/taskset-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  rewardTasksetFixture,
  tasksetFixture,
} from "./helpers/training-fixtures.js";
import {
  qualifyHarnessModelImprovement,
  requireQualifiedModelImprovement,
  runHarnessReviewBaselineAndQualification,
} from "../apps/server/src/training/harness-model-improvement.js";

const NOW = "2026-08-08T18:00:00.000Z";
const privacyApproval = { id: "privacy-approval", contentHash: contentHash("privacy-approval") };
const budgetApproval = { id: "budget-approval", contentHash: contentHash("budget-approval") };
const sourcePolicy = {
  policy: { id: "source-policy", contentHash: contentHash("source-policy") },
  state: "authorized" as const,
  checkedAt: NOW,
};

function tasksetWithLineage(base = tasksetFixture({ ready: true })) {
  const draft = TasksetSchema.parse({
    ...base,
    metadata: {
      ...base.metadata,
      harnessEvaluationReview: reviewRef,
      harnessEvaluationLineage: {
        review: {
          ...reviewRef,
          workspaceId: "workspace-qualification",
          harnessRelease: genericToolConformance.manifest.harnessRelease,
          claimFingerprint: contentHash("claim"),
        },
        evidenceRefs: [{ id: "route-one", contentHash: contentHash("route-one") }],
        sourcePolicies: [sourcePolicy],
      },
    },
    contentHash: "00000000",
  });
  const tasksetHash = computeTasksetHash(draft);
  return TasksetSchema.parse({
    ...draft,
    contentHash: tasksetHash,
    readiness: draft.readiness ? { ...draft.readiness, tasksetHash } : null,
  });
}

function baseline(input: {
  tasksetId: string;
  tasksetHash: string;
  score: number;
  scoreVariance: number;
}) {
  const receipt = createAttemptReceipt({
    schemaVersion: "openpond.attemptReceipt.v1",
    id: `attempt-${input.score}-${input.scoreVariance}`,
    runManifest: {
      id: genericToolConformance.manifest.id,
      contentHash: genericToolConformance.manifest.contentHash,
    },
    taskId: "task-eval",
    seed: "17",
    terminal: true,
    failureClass: null,
    outputHash: contentHash("output"),
    traceHash: contentHash("trace"),
    artifactRefs: [],
    graderEvidenceRefs: [],
    startedAt: NOW,
    completedAt: NOW,
    latencyMs: 1,
    costUsd: 0,
    legacyAttemptRef: null,
    metadata: { score: input.score, rewardEligible: true },
  });
  return aggregateEvaluationReceipts({
    id: `baseline-${input.score}-${input.scoreVariance}`,
    manifest: genericToolConformance.manifest,
    receipts: [receipt],
    metadata: {
      kind: "baseline",
      sourceTasksetId: input.tasksetId,
      sourceTasksetRevision: 1,
      sourceTasksetHash: input.tasksetHash,
      harnessEvaluationReview: reviewRef,
      environmentHash: contentHash("environment"),
      toolContractHash: contentHash("tools"),
      permissionContractHash: contentHash("permissions"),
      policyHash: contentHash("policy"),
      verifierRef: { id: "verifier", contentHash: contentHash("verifier") },
      scoreVariance: input.scoreVariance,
    },
  });
}

function originReview() {
  return createHarnessEvaluationReviewReceipt({
    schemaVersion: "openpond.harnessEvaluationReviewReceipt.v1",
    id: "review-qualification",
    ownerScope: { kind: "personal", id: "desktop-personal" },
    workspaceRef: "workspace-qualification",
    harnessRelease: genericToolConformance.manifest.harnessRelease,
    previousWatermark: null,
    nextWatermark: { cursor: contentHash("cursor"), throughCreatedAt: NOW },
    selectedEvidence: [{
      evidence: { id: "route-one", contentHash: contentHash("route-one") },
      kind: "route_decision",
      sourceRef: "session-one",
      sourcePolicy,
      occurrenceKey: contentHash("occurrence"),
      occurredAt: NOW,
    }],
    excludedEvidence: [],
    claim: {
      fingerprint: contentHash("claim"),
      recurrenceFamily: "behavior-gap",
      statement: "The repeated behavior gap remains unresolved.",
      independentOccurrences: 3,
      unresolvedOccurrences: 3,
    },
    classification: "taskset",
    triage: [{
      layer: "evaluation",
      status: "unresolved",
      reason: "The repeated claim requires controlled Evaluation.",
      evidenceRefs: [{ id: "route-one", contentHash: contentHash("route-one") }],
    }],
    reason: "The repeated claim requires controlled Evaluation.",
    nextAuthority: "human_review",
    maxEstimatedCostUsd: 5,
    tasksetProposal: null,
    evaluation: null,
    trainingQualification: null,
    policyVersion: "qualification-policy-v1",
    createdAt: NOW,
    metadata: {},
  });
}

const ORIGIN_REVIEW = originReview();
const reviewRef = { id: ORIGIN_REVIEW.id, contentHash: ORIGIN_REVIEW.contentHash };

function storeFixture(taskset: ReturnType<typeof tasksetWithLineage>, evaluation: ReturnType<typeof baseline>) {
  const saved: Array<{ kind: string; artifact: { id: string; contentHash: string } }> = [];
  const review = ORIGIN_REVIEW;
  const store = {
    getTaskset: vi.fn(async () => taskset),
    getEvaluationResult: vi.fn(async () => evaluation),
    listHarnessImprovementArtifacts: vi.fn(async (_workspaceId: string, kind: string) => {
      if (kind === "evaluation_review") return [review];
      if (kind === "training_qualification") return saved
        .filter((item) => item.kind === kind)
        .map((item) => item.artifact);
      return [];
    }),
    saveHarnessImprovementArtifact: vi.fn(async (_workspaceId: string, kind: string, artifact) => {
      saved.push({ kind, artifact });
      return artifact;
    }),
  };
  return { store: store as never, saved };
}

describe("Harness model-improvement qualification", () => {
  it("runs one real reviewed baseline and records a no-training qualification before approval", async () => {
    const taskset = tasksetWithLineage(rewardTasksetFixture());
    const evaluation = baseline({
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      score: 0.2,
      scoreVariance: 0,
    });
    const { store } = storeFixture(taskset, evaluation);
    const executeBaseline = vi.fn(async () => ({
      evaluationResult: evaluation,
      attempts: [{ id: "attempt-one" }],
      reused: false,
    }));
    const result = await runHarnessReviewBaselineAndQualification({
      store,
      evaluation: { executeBaseline } as never,
      workspaceId: "workspace-qualification",
      tasksetId: taskset.id,
      reviewRef,
      model: { providerId: "openpond", modelId: "openpond-chat" },
      maximumCostUsd: 0.1,
    });
    expect(executeBaseline).toHaveBeenCalledWith(expect.objectContaining({
      tasksetId: taskset.id,
      reviewRef,
      model: { providerId: "openpond", modelId: "openpond-chat" },
      seeds: [17],
      attemptsPerTask: 1,
    }));
    expect(result).toMatchObject({
      evaluationResult: { id: evaluation.id },
      attemptCount: 1,
      reused: false,
      qualification: {
        decision: "no_training",
        signal: { kind: "scalar_reward", strength: "weak", variance: 0 },
      },
    });
    expect(result.qualification.reasons).toEqual(expect.arrayContaining([
      "A separate privacy approval over eligible training evidence is required.",
      "A separate bounded-cost approval is required before planning training.",
    ]));
  });

  it("qualifies usable demonstration signal for SFT and links it to review history", async () => {
    const taskset = tasksetWithLineage();
    const evaluation = baseline({ tasksetId: taskset.id, tasksetHash: taskset.contentHash, score: 0.2, scoreVariance: 0.04 });
    const { store, saved } = storeFixture(taskset, evaluation);
    const receipt = await qualifyHarnessModelImprovement({
      store,
      tasksetId: taskset.id,
      baselineEvaluationId: evaluation.id,
      reviewRef,
      privacyApproval,
      budgetApproval,
      maximumCostUsd: 5,
      now: () => NOW,
    });
    expect(receipt).toMatchObject({
      decision: "sft",
      signal: { kind: "demonstrations", strength: "usable", calibrated: true, confounded: false },
      privacyApproval,
      budgetApproval,
    });
    expect(saved.map((item) => item.kind)).toEqual([
      "training_qualification",
      "evaluation_review",
    ]);
    expect(saved.at(-1)?.artifact).toMatchObject({
      classification: "model_improvement",
      trainingQualification: { id: receipt.id, contentHash: receipt.contentHash },
    });
  });

  it("returns no-training when the baseline already passes", async () => {
    const taskset = tasksetWithLineage();
    const evaluation = baseline({ tasksetId: taskset.id, tasksetHash: taskset.contentHash, score: 1, scoreVariance: 0 });
    const { store } = storeFixture(taskset, evaluation);
    const receipt = await qualifyHarnessModelImprovement({
      store,
      tasksetId: taskset.id,
      baselineEvaluationId: evaluation.id,
      reviewRef,
      privacyApproval,
      budgetApproval,
      maximumCostUsd: 5,
      now: () => NOW,
    });
    expect(receipt.decision).toBe("no_training");
    expect(receipt.reasons).toContain("The real baseline already meets the protected success threshold.");
  });

  it("requires exact method, base Model, Taskset, and cost before planning", async () => {
    const taskset = tasksetWithLineage();
    const evaluation = baseline({ tasksetId: taskset.id, tasksetHash: taskset.contentHash, score: 0.2, scoreVariance: 0.04 });
    const qualificationStore = storeFixture(taskset, evaluation);
    const receipt = await qualifyHarnessModelImprovement({
      store: qualificationStore.store,
      tasksetId: taskset.id,
      baselineEvaluationId: evaluation.id,
      reviewRef,
      privacyApproval,
      budgetApproval,
      maximumCostUsd: 5,
      now: () => NOW,
    });
    const store = {
      getTaskset: vi.fn(async () => taskset),
      listHarnessImprovementArtifacts: vi.fn(async () => [receipt]),
    };
    await expect(requireQualifiedModelImprovement({
      store: store as never,
      workspaceId: "workspace-qualification",
      qualificationRef: { id: receipt.id, contentHash: receipt.contentHash },
      tasksetId: taskset.id,
      recipe: { method: "sft" },
      baseModelId: receipt.model.model,
      maximumCostUsd: 5,
    })).resolves.toEqual(receipt);
    await expect(requireQualifiedModelImprovement({
      store: store as never,
      workspaceId: "workspace-qualification",
      qualificationRef: { id: receipt.id, contentHash: receipt.contentHash },
      tasksetId: taskset.id,
      recipe: { method: "ppo" },
      baseModelId: receipt.model.model,
      maximumCostUsd: 5,
    })).rejects.toThrow("recipe method");
    await expect(requireQualifiedModelImprovement({
      store: store as never,
      workspaceId: "workspace-qualification",
      qualificationRef: { id: receipt.id, contentHash: receipt.contentHash },
      tasksetId: taskset.id,
      recipe: { method: "sft" },
      baseModelId: receipt.model.model,
      maximumCostUsd: 6,
    })).rejects.toThrow("maximum cost");
  });

  it("blocks RL when scalar reward has no baseline variance", async () => {
    const taskset = tasksetWithLineage(rewardTasksetFixture());
    const evaluation = baseline({ tasksetId: taskset.id, tasksetHash: taskset.contentHash, score: 0.2, scoreVariance: 0 });
    const { store } = storeFixture(taskset, evaluation);
    const receipt = await qualifyHarnessModelImprovement({
      store,
      tasksetId: taskset.id,
      baselineEvaluationId: evaluation.id,
      reviewRef,
      privacyApproval,
      budgetApproval,
      maximumCostUsd: 5,
      now: () => NOW,
    });
    expect(receipt).toMatchObject({
      decision: "no_training",
      signal: { kind: "scalar_reward", strength: "weak", variance: 0 },
    });
  });
});
