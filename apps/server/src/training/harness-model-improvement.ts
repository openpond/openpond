import {
  ChatModelRefSchema,
  type HarnessEvaluationReviewReceipt,
  type Taskset,
  isTrainingSourceRef,
} from "@openpond/contracts";
import {
  HarnessReviewSourcePolicyRefSchema,
  ImmutableReleaseRefSchema,
  contentHash,
  createHarnessEvaluationReviewReceipt,
  createModelImprovementQualificationReceipt,
  type EvaluationResult,
  type ModelImprovementQualificationReceipt,
} from "@openpond/evals";
import { z } from "zod";

import type { SqliteStore } from "../store/store.js";
import type { createTaskEvaluationService } from "./evaluation-service.js";

type ImmutableRef = { id: string; contentHash: string };

export const HarnessReviewBaselineRequestSchema = z.object({
  workspaceId: z.string().trim().min(1),
  tasksetId: z.string().trim().min(1),
  reviewRef: z.object({
    id: z.string().trim().min(1),
    contentHash: z.string().trim().min(1),
  }).strict(),
  model: ChatModelRefSchema,
  maximumCostUsd: z.number().finite().nonnegative(),
  seeds: z.array(z.number().int()).min(1).max(10).optional(),
  attemptsPerTask: z.number().int().min(1).max(3).optional(),
}).strict();

export async function runHarnessReviewBaselineAndQualification(input: {
  store: SqliteStore;
  evaluation: Pick<ReturnType<typeof createTaskEvaluationService>, "executeBaseline">;
  workspaceId: string;
  tasksetId: string;
  reviewRef: ImmutableRef;
  model: import("@openpond/contracts").ChatModelRef;
  maximumCostUsd: number;
  seeds?: number[];
  attemptsPerTask?: number;
}): Promise<{
  evaluationResult: EvaluationResult;
  attemptCount: number;
  reused: boolean;
  qualification: ModelImprovementQualificationReceipt;
}> {
  const baseline = await input.evaluation.executeBaseline({
    tasksetId: input.tasksetId,
    model: input.model,
    reviewRef: input.reviewRef,
    seeds: input.seeds?.length ? input.seeds : [17],
    attemptsPerTask: input.attemptsPerTask ?? 1,
    sampling: {
      maxOutputTokens: 4_096,
      temperature: 0,
      topP: 1,
    },
  });
  const qualification = await qualifyHarnessModelImprovement({
    store: input.store,
    tasksetId: input.tasksetId,
    baselineEvaluationId: baseline.evaluationResult.id,
    reviewRef: input.reviewRef,
    privacyApproval: null,
    budgetApproval: null,
    maximumCostUsd: input.maximumCostUsd,
  });
  if (qualification.metadata.workspaceId !== input.workspaceId) {
    throw new Error("Baseline qualification does not match the requested Harness workspace.");
  }
  return {
    evaluationResult: baseline.evaluationResult,
    attemptCount: baseline.evaluationResult.attemptCount,
    reused: baseline.reused,
    qualification,
  };
}

export async function qualifyHarnessModelImprovement(input: {
  store: SqliteStore;
  tasksetId: string;
  baselineEvaluationId: string;
  reviewRef: ImmutableRef;
  privacyApproval?: ImmutableRef | null;
  budgetApproval?: ImmutableRef | null;
  maximumCostUsd: number;
  now?: () => string;
}): Promise<ModelImprovementQualificationReceipt> {
  const [taskset, baseline] = await Promise.all([
    input.store.getTaskset(input.tasksetId),
    input.store.getEvaluationResult(input.baselineEvaluationId),
  ]);
  if (!taskset) throw new Error("Taskset was not found for model-improvement qualification.");
  if (!baseline) throw new Error("Baseline Evaluation was not found.");
  if (
    taskset.status !== "ready" ||
    taskset.readiness?.ready !== true ||
    taskset.readiness.tasksetHash !== taskset.contentHash
  ) {
    throw new Error("Taskset readiness is stale or blocked.");
  }
  assertBaselineLineage(taskset, baseline, input.reviewRef);
  const lineage = harnessLineage(taskset);
  const sourcePolicies = HarnessReviewSourcePolicyRefSchema.array().parse(lineage.sourcePolicies);
  const frozenEvidenceRefs = taskEvidenceRefs(
    taskset,
    new Set(taskset.tasks.filter((task) => task.split === "frozen_eval").flatMap((task) => task.sourceRefs)),
  );
  const signal = signalForTaskset(taskset, baseline);
  const trainingEvidenceRefs = taskEvidenceRefs(taskset, signal.sourceIds);
  const privacyReady = taskset.sourceRefs.every((source) =>
    !isTrainingSourceRef(source) || (
      source.consent.status === "granted" &&
      source.secretScanStatus === "passed" &&
      source.piiScanStatus === "passed" &&
      source.licensingStatus === "approved"
    ),
  );
  const reasons = [...signal.reasons];
  let decision = signal.decision;
  if (baseline.meanScore !== null && baseline.meanScore >= 0.95) {
    decision = "no_training";
    reasons.push("The real baseline already meets the protected success threshold.");
  }
  if (!privacyReady || !input.privacyApproval) {
    decision = "no_training";
    reasons.push("A separate privacy approval over eligible training evidence is required.");
  }
  if (!input.budgetApproval) {
    decision = "no_training";
    reasons.push("A separate bounded-cost approval is required before planning training.");
  }
  if (!sourcePolicies.length || sourcePolicies.some((policy) => policy.state !== "authorized")) {
    decision = "no_training";
    reasons.push("Every learning source must retain an authorized source-policy receipt.");
  }
  if (signal.confounded) {
    decision = "no_training";
    reasons.push("The baseline signal is confounded by non-reward-eligible or infrastructure outcomes.");
  }

  const createdAt = (input.now ?? (() => new Date().toISOString()))();
  const tasksetRelease = {
    id: baseline.tasksetRelease.id,
    contentHash: baseline.tasksetRelease.contentHash,
  };
  const verifierRef = immutableRef(baseline.metadata.verifierRef, "Baseline verifier");
  const receipt = createModelImprovementQualificationReceipt({
    schemaVersion: "openpond.modelImprovementQualificationReceipt.v1",
    id: `model-qualification-${contentHash({
      review: input.reviewRef,
      tasksetRelease,
      baseline: baseline.contentHash,
      model: baseline.model,
      privacyApproval: input.privacyApproval ?? null,
      budgetApproval: input.budgetApproval ?? null,
      maximumCostUsd: input.maximumCostUsd,
      decision,
    }).slice(0, 24)}`,
    review: input.reviewRef,
    harnessRelease: baseline.harnessRelease,
    tasksetRelease,
    baselineEvaluation: { id: baseline.id, contentHash: baseline.contentHash },
    model: baseline.model,
    environmentHash: hashMetadata(baseline, "environmentHash"),
    toolContractHash: hashMetadata(baseline, "toolContractHash"),
    permissionContractHash: hashMetadata(baseline, "permissionContractHash"),
    policyHash: hashMetadata(baseline, "policyHash"),
    verifierRef,
    sourcePolicies,
    trainingEvidenceRefs,
    frozenEvaluationEvidenceRefs: frozenEvidenceRefs,
    privacyApproval: input.privacyApproval ?? null,
    budgetApproval: input.budgetApproval ?? null,
    maximumCostUsd: input.maximumCostUsd,
    signal: {
      kind: signal.kind,
      strength: signal.strength,
      calibrated: signal.calibrated,
      confounded: signal.confounded,
      variance: signal.variance,
      evidenceRefs: trainingEvidenceRefs,
    },
    decision,
    reasons: [...new Set(reasons)],
    createdAt,
    metadata: {
      sourceTasksetId: taskset.id,
      sourceTasksetRevision: taskset.revision,
      sourceTasksetHash: taskset.contentHash,
      workspaceId: lineage.review.workspaceId,
    },
  });
  const existing = (await input.store.listHarnessImprovementArtifacts(
    lineage.review.workspaceId,
    "training_qualification",
    1_000,
  ) as ModelImprovementQualificationReceipt[]).find((candidate) => candidate.id === receipt.id);
  if (existing) {
    if (existing.contentHash !== receipt.contentHash) {
      throw new Error("Model-improvement qualification ID already has different immutable content.");
    }
    return existing;
  }
  await input.store.saveHarnessImprovementArtifact(
    lineage.review.workspaceId,
    "training_qualification",
    receipt,
  );
  await linkQualificationReview({
    store: input.store,
    originRef: input.reviewRef,
    workspaceId: lineage.review.workspaceId,
    taskset,
    baseline,
    qualification: receipt,
    createdAt,
  });
  return receipt;
}

export async function requireQualifiedModelImprovement(input: {
  store: SqliteStore;
  workspaceId: string;
  qualificationRef: ImmutableRef;
  tasksetId: string;
  recipe: { method?: unknown };
  baseModelId: string;
  maximumCostUsd?: number | null;
}): Promise<ModelImprovementQualificationReceipt> {
  const receipt = (await input.store.listHarnessImprovementArtifacts(
    input.workspaceId,
    "training_qualification",
    1_000,
  ) as ModelImprovementQualificationReceipt[]).find((candidate) =>
    candidate.id === input.qualificationRef.id &&
    candidate.contentHash === input.qualificationRef.contentHash,
  );
  if (!receipt || receipt.decision === "no_training") {
    throw new Error("A qualified model-improvement receipt is required before planning training.");
  }
  const taskset = await input.store.getTaskset(input.tasksetId);
  if (!taskset || taskset.metadata.harnessEvaluationReview === undefined) {
    throw new Error("Qualified Taskset was not found.");
  }
  if (receipt.metadata.sourceTasksetId !== taskset.id || receipt.metadata.sourceTasksetHash !== taskset.contentHash) {
    throw new Error("Model-improvement qualification does not match the current immutable Taskset.");
  }
  if (!recipeMatches(receipt.decision, input.recipe.method)) {
    throw new Error("Training recipe method does not match the qualification decision.");
  }
  if (receipt.model.model !== input.baseModelId) {
    throw new Error("Training base Model does not match the qualified baseline Model.");
  }
  if (
    input.maximumCostUsd !== null &&
    input.maximumCostUsd !== undefined &&
    input.maximumCostUsd > receipt.maximumCostUsd
  ) {
    throw new Error("Training approval exceeds the qualified maximum cost.");
  }
  return receipt;
}

function signalForTaskset(taskset: Taskset, baseline: EvaluationResult): {
  decision: ModelImprovementQualificationReceipt["decision"];
  kind: ModelImprovementQualificationReceipt["signal"]["kind"];
  strength: ModelImprovementQualificationReceipt["signal"]["strength"];
  calibrated: boolean;
  confounded: boolean;
  variance: number | null;
  sourceIds: Set<string>;
  reasons: string[];
} {
  const calibrated = taskset.graders.every((grader) =>
    grader.kind !== "model_judge" || grader.calibrationStatus === "passed",
  );
  const confounded = baseline.rewardEligibleCount < baseline.attemptCount ||
    (baseline.failureCounts.infrastructure_failure ?? 0) > 0;
  const variance = typeof baseline.metadata.scoreVariance === "number"
    ? baseline.metadata.scoreVariance
    : null;
  if (taskset.learningSignals.rewards.length) {
    const sourceIds = new Set(taskset.learningSignals.rewards.flatMap((signal) => signal.sourceRefs));
    const usable = calibrated && !confounded && variance !== null && variance > 0 && sourceIds.size > 0;
    return {
      decision: usable ? "rl" : "no_training",
      kind: "scalar_reward",
      strength: usable ? "usable" : variance === 0 ? "weak" : "absent",
      calibrated,
      confounded,
      variance,
      sourceIds,
      reasons: [usable
        ? "The Taskset has calibrated scalar reward with non-zero baseline variance."
        : "RL requires calibrated, non-confounded scalar reward with non-zero baseline variance."],
    };
  }
  if (taskset.learningSignals.preferences.length) {
    const sourceIds = new Set(taskset.learningSignals.preferences.flatMap((signal) => signal.sourceRefs));
    const usable = calibrated && !confounded && sourceIds.size > 0;
    return {
      decision: usable ? "preference" : "no_training",
      kind: "chosen_rejected",
      strength: usable ? "usable" : "weak",
      calibrated,
      confounded,
      variance,
      sourceIds,
      reasons: [usable
        ? "The Taskset has approved chosen/rejected pairs."
        : "Preference training lacks usable approved chosen/rejected signal."],
    };
  }
  if (taskset.learningSignals.demonstrations.length) {
    const sourceIds = new Set(taskset.learningSignals.demonstrations.flatMap((signal) => signal.sourceRefs));
    const usable = calibrated && !confounded && sourceIds.size > 0;
    return {
      decision: usable ? "sft" : "no_training",
      kind: "demonstrations",
      strength: usable ? "usable" : "weak",
      calibrated,
      confounded,
      variance,
      sourceIds,
      reasons: [usable
        ? "The Taskset has approved demonstration signal."
        : "SFT lacks usable approved demonstration signal."],
    };
  }
  return {
    decision: "no_training",
    kind: "none",
    strength: "absent",
    calibrated,
    confounded,
    variance,
    sourceIds: new Set(),
    reasons: ["The Taskset has no eligible non-frozen learning signal."],
  };
}

function taskEvidenceRefs(taskset: Taskset, sourceIds: Set<string>): ImmutableRef[] {
  return taskset.sourceRefs
    .filter((source) => sourceIds.has(source.id))
    .map((source) => ({
      id: source.id,
      contentHash: isTrainingSourceRef(source) ? source.sourceHash : contentHash(source),
    }));
}

function assertBaselineLineage(taskset: Taskset, baseline: EvaluationResult, reviewRef: ImmutableRef): void {
  const boundReview = taskset.metadata.harnessEvaluationReview;
  if (!sameRef(boundReview, reviewRef)) {
    throw new Error("Taskset does not match the supplied Harness Evaluation review.");
  }
  if (
    baseline.metadata.kind !== "baseline" ||
    baseline.metadata.sourceTasksetId !== taskset.id ||
    baseline.metadata.sourceTasksetHash !== taskset.contentHash ||
    !sameRef(baseline.metadata.harnessEvaluationReview, reviewRef)
  ) {
    throw new Error("Baseline Evaluation lineage does not match the Taskset and review.");
  }
}

function harnessLineage(taskset: Taskset): {
  review: { id: string; contentHash: string; workspaceId: string };
  sourcePolicies: unknown[];
} {
  const value = taskset.metadata.harnessEvaluationLineage;
  if (!isRecord(value) || !isRecord(value.review) || !Array.isArray(value.sourcePolicies)) {
    throw new Error("Taskset has no exact Harness Evaluation source-policy lineage.");
  }
  return {
    review: {
      id: String(value.review.id ?? ""),
      contentHash: String(value.review.contentHash ?? ""),
      workspaceId: String(value.review.workspaceId ?? ""),
    },
    sourcePolicies: value.sourcePolicies,
  };
}

async function linkQualificationReview(input: {
  store: SqliteStore;
  originRef: ImmutableRef;
  workspaceId: string;
  taskset: Taskset;
  baseline: EvaluationResult;
  qualification: ModelImprovementQualificationReceipt;
  createdAt: string;
}): Promise<void> {
  const reviews = await input.store.listHarnessImprovementArtifacts(
    input.workspaceId,
    "evaluation_review",
    1_000,
  ) as HarnessEvaluationReviewReceipt[];
  const origin = reviews.find((review) => sameRef(review, input.originRef));
  if (!origin) throw new Error("Originating Harness Evaluation review was not found.");
  const qualificationRef = { id: input.qualification.id, contentHash: input.qualification.contentHash };
  const linkKey = contentHash({
    origin: input.originRef,
    taskset: input.taskset.contentHash,
    baseline: input.baseline.contentHash,
    qualification: qualificationRef,
  });
  if (reviews.some((review) => review.metadata.downstreamLinkKey === linkKey)) return;
  const qualified = input.qualification.decision !== "no_training";
  const receipt = createHarnessEvaluationReviewReceipt({
    schemaVersion: "openpond.harnessEvaluationReviewReceipt.v1",
    id: `evaluation-review-qualification-${linkKey.slice(0, 24)}`,
    ownerScope: origin.ownerScope,
    workspaceRef: origin.workspaceRef,
    harnessRelease: origin.harnessRelease,
    previousWatermark: origin.nextWatermark,
    nextWatermark: {
      cursor: contentHash({ cursor: origin.nextWatermark.cursor, qualificationRef }),
      throughCreatedAt: input.createdAt,
    },
    selectedEvidence: origin.selectedEvidence,
    excludedEvidence: origin.excludedEvidence,
    claim: origin.claim,
    classification: qualified ? "model_improvement" : "taskset",
    triage: [...origin.triage, {
      layer: "model",
      status: qualified ? "unresolved" : "blocked",
      reason: input.qualification.reasons.join(" "),
      evidenceRefs: [
        { id: input.baseline.id, contentHash: input.baseline.contentHash },
        qualificationRef,
      ],
    }],
    reason: input.qualification.reasons.join(" "),
    nextAuthority: "human_review",
    maxEstimatedCostUsd: input.qualification.maximumCostUsd,
    tasksetProposal: { id: input.taskset.id, contentHash: input.taskset.contentHash },
    evaluation: { id: input.baseline.id, contentHash: input.baseline.contentHash },
    trainingQualification: qualificationRef,
    policyVersion: origin.policyVersion,
    createdAt: input.createdAt,
    metadata: { originReview: input.originRef, downstreamLinkKey: linkKey },
  });
  await input.store.saveHarnessImprovementArtifact(input.workspaceId, "evaluation_review", receipt);
}

function immutableRef(value: unknown, label: string): ImmutableRef {
  const parsed = ImmutableReleaseRefSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${label} reference is missing from the baseline Evaluation.`);
  return parsed.data;
}

function hashMetadata(baseline: EvaluationResult, key: string): string {
  const value = baseline.metadata[key];
  if (typeof value !== "string") throw new Error(`Baseline Evaluation is missing ${key}.`);
  return value;
}

function recipeMatches(
  decision: ModelImprovementQualificationReceipt["decision"],
  method: unknown,
): boolean {
  if (decision === "sft") return method === "sft";
  if (decision === "preference") return method === "dpo";
  if (decision === "rl") return method === "grpo" || method === "ppo";
  return false;
}

function sameRef(value: unknown, expected: ImmutableRef): boolean {
  return isRecord(value) && value.id === expected.id && value.contentHash === expected.contentHash;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
