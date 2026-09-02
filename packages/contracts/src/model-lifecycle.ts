import { z } from "zod";

import {
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  VersionedReleaseRefSchema,
} from "./release-core.js";
import {
  BaseModelPreferenceSchema,
  TaskFailureClassSchema,
} from "./tasksets.js";
import { ChatModelRefSchema } from "./providers.js";
import { CorrelatedTelemetryReceiptSchema } from "./training-benchmark.js";
import { ModelComparisonEntryRefSchema, ModelComparisonParentSchema } from "./model-comparisons.js";

export const ModelVersionKindSchema = z.enum([
  "base_reference",
  "lora_adapter",
]);

/** Exact tokenizer/model runtime used to train and later serve a Reward Model. */
export const RewardModelRuntimeSchema = z.object({
  baseModel: z.object({
    source: z.literal("huggingface"),
    repoId: ReleaseIdSchema,
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    configHash: ReleaseHashSchema,
    tokenizerHash: ReleaseHashSchema,
    licenseId: ReleaseIdSchema,
    gated: z.boolean(),
  }).strict(),
  processor: z.object({
    repository: ReleaseIdSchema,
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    configHash: ReleaseHashSchema,
  }).strict(),
}).strict().superRefine((runtime, context) => {
  if (
    runtime.baseModel.repoId !== runtime.processor.repository
    || runtime.baseModel.revision !== runtime.processor.revision
  ) {
    context.addIssue({
      code: "custom",
      path: ["processor"],
      message: "Reward Model processor must match the pinned scorer base model.",
    });
  }
});

export const ModelVersionSchema = z
  .object({
    schemaVersion: z.literal("openpond.modelVersion.v1"),
    id: ReleaseIdSchema,
    modelId: ReleaseIdSchema,
    profileId: ReleaseIdSchema,
    version: z.number().int().nonnegative(),
    kind: ModelVersionKindSchema,
    status: z.enum(["available", "failed"]),
    baseModel: BaseModelPreferenceSchema,
    taskset: VersionedReleaseRefSchema,
    comparisonSeriesEntry: ModelComparisonEntryRefSchema.nullable().optional(),
    releaseGraph: z
      .object({
        resolvedBundleHash: ReleaseHashSchema,
        profileRelease: VersionedReleaseRefSchema,
        harnessRelease: ImmutableReleaseRefSchema,
        agentRelease: ImmutableReleaseRefSchema.nullable(),
        grader: z
          .object({
            id: ReleaseIdSchema,
            contentHash: ReleaseHashSchema,
          })
          .strict(),
      })
      .strict(),
    artifactLineageId: ReleaseIdSchema.nullable(),
    adapterStatus: z.enum(["not_trained", "trained"]),
    createdAt: ReleaseTimestampSchema,
    contentHash: ReleaseHashSchema,
  })
  .strict()
  .superRefine((version, context) => {
    if (
      version.kind === "base_reference"
      && (
        version.version !== 0
        || version.adapterStatus !== "not_trained"
        || version.artifactLineageId !== null
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A base-reference Model Version must be version 0 without adapter lineage.",
      });
    }
    if (
      version.kind === "lora_adapter"
      && (
        version.version === 0
        || version.adapterStatus !== "trained"
        || !version.artifactLineageId
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A LoRA Model Version must be version 1+ with adapter lineage.",
      });
    }
  });

export const RewardModelVersionSchema = z.object({
  schemaVersion: z.literal("openpond.rewardModelVersion.v1"),
  id: ReleaseIdSchema,
  modelId: ReleaseIdSchema,
  profileId: ReleaseIdSchema,
  version: z.number().int().positive(),
  role: z.literal("reward"),
  status: z.enum(["available", "failed"]),
  scope: z.enum(["synthetic_smoke", "human_preference"]),
  baseModel: BaseModelPreferenceSchema,
  // Older persisted versions predate executable scorer identity.
  // They remain readable but cannot be bound to a new policy run.
  runtime: RewardModelRuntimeSchema.nullable().default(null),
  taskset: VersionedReleaseRefSchema,
  preferenceDatasetRelease: ImmutableReleaseRefSchema,
  releaseGraph: z.object({
    resolvedBundleHash: ReleaseHashSchema,
    profileRelease: VersionedReleaseRefSchema,
    harnessRelease: ImmutableReleaseRefSchema,
    grader: z.object({
      id: ReleaseIdSchema,
      contentHash: ReleaseHashSchema,
    }).strict(),
  }).strict(),
  artifacts: z.object({
    checkpoint: ImmutableReleaseRefSchema.extend({
      objectRef: z.string().regex(/^r2:\/\/[A-Za-z0-9._/-]+$/),
      files: z.array(z.object({
        path: z.string().trim().min(1).max(512),
        sizeBytes: z.number().int().positive(),
        sha256: ReleaseHashSchema,
      }).strict()).min(4).max(128),
    }).strict(),
    adapter: ImmutableReleaseRefSchema,
    scalarHead: ImmutableReleaseRefSchema,
    bucketHead: ImmutableReleaseRefSchema.nullable(),
    processorRelease: ImmutableReleaseRefSchema,
  }).strict(),
  qualificationReport: ImmutableReleaseRefSchema.nullable(),
  createdAt: ReleaseTimestampSchema,
  contentHash: ReleaseHashSchema,
}).strict();

export const RewardModelRunReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.rewardModelRunReceipt.v1"),
  provider: ReleaseIdSchema,
  providerRunId: ReleaseIdSchema,
  resolvedBundleHash: ReleaseHashSchema,
  finalCheckpoint: ImmutableReleaseRefSchema.extend({
    objectRef: z.string().regex(/^r2:\/\/[A-Za-z0-9._/-]+$/),
  }).strict(),
  adapter: ImmutableReleaseRefSchema,
  scalarHead: ImmutableReleaseRefSchema,
  bucketHead: ImmutableReleaseRefSchema.nullable(),
  processorRelease: ImmutableReleaseRefSchema,
  optimizerEvidence: ImmutableReleaseRefSchema,
  managedExecutionReceipt: ImmutableReleaseRefSchema.nullable().default(null),
  parameterDeltaHash: ReleaseHashSchema,
  cleanup: z.object({
    computeReleased: z.boolean(),
    providerTerminalObserved: z.boolean(),
  }).strict(),
  contentHash: ReleaseHashSchema,
}).strict();

export const RewardModelRunSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.tasksetRelease !== undefined) return value;
  const taskset = record.taskset;
  if (!taskset || typeof taskset !== "object" || Array.isArray(taskset)) return value;
  const tasksetRecord = taskset as Record<string, unknown>;
  if (typeof tasksetRecord.id !== "string" || typeof tasksetRecord.contentHash !== "string") {
    return value;
  }
  // Historical local RM smoke records predate the explicit immutable release
  // ref. Preserve their inspectability; all new launch paths write the exact
  // published Taskset release instead of relying on this compatibility value.
  return {
    ...record,
    tasksetRelease: {
      id: tasksetRecord.id,
      contentHash: tasksetRecord.contentHash,
    },
  };
}, z.object({
  schemaVersion: z.literal("openpond.rewardModelRun.v1"),
  id: ReleaseIdSchema,
  rewardModelId: ReleaseIdSchema,
  rewardModelVersionId: ReleaseIdSchema.nullable(),
  profileId: ReleaseIdSchema,
  role: z.literal("reward"),
  scope: z.enum(["synthetic_smoke", "human_preference"]),
  status: z.enum(["prepared", "running", "succeeded", "failed", "cancelled"]),
  taskset: VersionedReleaseRefSchema,
  tasksetRelease: ImmutableReleaseRefSchema,
  preferenceDatasetRelease: ImmutableReleaseRefSchema,
  recipeRelease: ImmutableReleaseRefSchema,
  destinationId: ReleaseIdSchema,
  quote: z.object({
    maximumSpendUsd: z.number().positive(),
    hourlyCostUsd: z.number().nonnegative().nullable(),
  }).strict(),
  managedRunId: ReleaseIdSchema.nullable(),
  progress: z.object({
    completedSteps: z.number().int().nonnegative(),
    totalSteps: z.number().int().positive(),
    latestLoss: z.number().finite().nullable(),
  }).strict(),
  receipt: RewardModelRunReceiptSchema.nullable(),
  qualificationReport: ImmutableReleaseRefSchema.nullable(),
  accruedSpendUsd: z.number().nonnegative().nullable(),
  failureOwner: z.enum(["authoring", "admission", "provider", "runner", "artifact", "qualification", "cleanup"]).nullable(),
  failure: z.string().trim().min(1).max(5_000).nullable(),
  startedAt: ReleaseTimestampSchema,
  completedAt: ReleaseTimestampSchema.nullable(),
  updatedAt: ReleaseTimestampSchema,
}).strict()).superRefine((run, context) => {
  if (run.status === "succeeded" && !run.receipt) {
    context.addIssue({
      code: "custom",
      message: "A successful Reward Model Run requires a canonical receipt.",
    });
  }
  if (run.status !== "succeeded" && run.rewardModelVersionId !== null) {
    context.addIssue({
      code: "custom",
      message: "Only a successful Reward Model Run can publish a Reward Model Version.",
    });
  }
});

export const ModelRunReceiptSchema = z
  .object({
    schemaVersion: z.literal("openpond.modelRunReceipt.v1"),
    provider: ReleaseIdSchema,
    providerRunId: ReleaseIdSchema,
    assignmentHash: ReleaseHashSchema,
    resultHash: ReleaseHashSchema,
    transcriptHash: ReleaseHashSchema,
    traceHash: ReleaseHashSchema.nullable(),
    resolvedBundleHash: ReleaseHashSchema,
    artifactPath: z.string().trim().min(1).max(2_000),
    cleanup: z
      .object({
        computeReleased: z.boolean(),
        tunnelClosed: z.boolean(),
      })
      .strict(),
    telemetry: CorrelatedTelemetryReceiptSchema.nullable().default(null),
    contentHash: ReleaseHashSchema,
  })
  .strict();

const EvaluationUsageCategorySchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
}).strict();
const GitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const ModelEvaluationAttemptSchema = z.object({
  phase: z.enum([
    "baseline",
    "adaptation",
    "candidate_adaptation",
    "candidate",
  ]),
  taskId: ReleaseIdSchema,
  attemptId: ReleaseIdSchema,
  sessionId: ReleaseIdSchema.nullable(),
  turnId: ReleaseIdSchema.nullable(),
  passed: z.boolean(),
  score: z.number().min(0).max(1).nullable(),
  failureClass: TaskFailureClassSchema.nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  startedAt: ReleaseTimestampSchema,
}).strict();

const ModelEvaluationTaskEfficiencyCohortSchema = z.object({
  targetTaskCount: z.number().int().nonnegative(),
  comparedTaskCount: z.number().int().nonnegative(),
  passedTaskCount: z.number().int().nonnegative(),
  failedTaskCount: z.number().int().nonnegative(),
  lowerTaskCount: z.number().int().nonnegative(),
  higherTaskCount: z.number().int().nonnegative(),
  unchangedTaskCount: z.number().int().nonnegative(),
}).strict();

export const ModelEvaluationTaskEfficiencySchema = z.object({
  target: z.literal("all_tasks_lower"),
  targetTaskCount: z.number().int().nonnegative(),
  comparedTaskCount: z.number().int().nonnegative(),
  passedTaskCount: z.number().int().nonnegative(),
  failedTaskCount: z.number().int().nonnegative(),
  lowerTaskCount: z.number().int().nonnegative(),
  higherTaskCount: z.number().int().nonnegative(),
  unchangedTaskCount: z.number().int().nonnegative(),
  baselineTokens: z.number().int().nonnegative(),
  refinedTokens: z.number().int().nonnegative(),
  tokenDelta: z.number().int(),
  tokenDeltaPercent: z.number().finite().nullable(),
  complete: z.boolean(),
  passed: z.boolean(),
  cohorts: z.object({
    adaptation: ModelEvaluationTaskEfficiencyCohortSchema,
    heldOut: ModelEvaluationTaskEfficiencyCohortSchema,
  }).strict(),
}).strict();

const ModelEvaluationUsageSchema = z.object({
  baseline: EvaluationUsageCategorySchema,
  adaptation: EvaluationUsageCategorySchema,
  candidateAdaptation: EvaluationUsageCategorySchema,
  candidate: EvaluationUsageCategorySchema,
  refiner: EvaluationUsageCategorySchema,
  grader: EvaluationUsageCategorySchema,
}).strict();

const ModelEvaluationAccountingSchema = z.object({
  usage: ModelEvaluationUsageSchema,
  observedSpendUsd: z.number().nonnegative(),
  attempts: z.array(ModelEvaluationAttemptSchema).max(10_000),
}).strict();

const ModelEvaluationEvidenceSnapshotSchema = z.object({
  id: ReleaseIdSchema,
  contentHash: ReleaseHashSchema,
  artifactPath: z.string().trim().min(1).max(2_000),
}).strict();

export const ModelEvaluationReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.modelEvaluationReceipt.v1"),
  benchmarkId: ReleaseIdSchema,
  resultManifest: z.object({
    id: ReleaseIdSchema,
    contentHash: ReleaseHashSchema,
    artifactPath: z.string().trim().min(1).max(2_000),
  }).strict(),
  stages: z.object({
    baseline: ImmutableReleaseRefSchema,
    adaptation: ImmutableReleaseRefSchema,
    refiner: ImmutableReleaseRefSchema,
    candidateAdaptation: ImmutableReleaseRefSchema,
    candidate: ImmutableReleaseRefSchema,
    comparison: ImmutableReleaseRefSchema,
  }).strict(),
  usage: ModelEvaluationUsageSchema,
  quality: z.object({
    baselinePassRate: z.number().min(0).max(1),
    candidatePassRate: z.number().min(0).max(1),
    adaptationBaselinePassRate: z.number().min(0).max(1),
    adaptationCandidatePassRate: z.number().min(0).max(1),
    adaptationCandidatePassed: z.boolean(),
    heldOutCandidatePassed: z.boolean(),
    passed: z.boolean(),
  }).strict(),
  foregroundTokenDelta: z.number().int(),
  foregroundTokenDeltaPercent: z.number().finite().nullable(),
  taskEfficiency: ModelEvaluationTaskEfficiencySchema.optional(),
  efficiency: z.object({
    grossForegroundTokenSavings: z.number().int(),
    overheadTokens: z.number().int().nonnegative(),
    firstPassNetTokenSavings: z.number().int(),
    breakEvenReuseCount: z.number().int().nonnegative().nullable(),
    amortizedTokenSavings: z.number().int(),
    amortizedReuseCount: z.number().int().positive(),
  }).strict(),
  budget: z.object({
    maximumSpendUsd: z.number().nonnegative(),
    observedSpendUsd: z.number().nonnegative(),
    enforced: z.boolean(),
  }).strict(),
  evidenceSnapshot: ImmutableReleaseRefSchema,
  lineage: z.object({
    adaptationEvidenceHash: ReleaseHashSchema,
    refinerInputHash: ReleaseHashSchema,
    refinerOutcomeHash: ReleaseHashSchema,
    validationHash: ReleaseHashSchema,
    applyReceiptHash: ReleaseHashSchema,
    candidateRelease: ImmutableReleaseRefSchema,
    valid: z.boolean(),
  }).strict(),
  invalidReasons: z.array(z.string().trim().min(1).max(2_000)).max(100),
  attempts: z.array(ModelEvaluationAttemptSchema).max(10_000).default([]),
  terminalClassification: z.enum([
    "improved",
    "no_improvement",
    "regressed",
    "inconclusive",
    "cancelled",
    "infrastructure_failure",
  ]),
  profileGit: z.object({
    ref: z.string().trim().min(1).max(2_000),
    commit: GitObjectIdSchema,
    baseCommit: GitObjectIdSchema,
  }).strict().nullable(),
  contentHash: ReleaseHashSchema,
}).strict();

export const ModelEvaluationStopReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.modelEvaluationStopReceipt.v1"),
  benchmarkId: ReleaseIdSchema,
  terminalClassification: z.literal("inconclusive"),
  stopReason: z.enum([
    "candidate_harness_unchanged",
    "candidate_lineage_invalid",
  ]),
  reason: z.string().trim().min(1).max(5_000),
  stoppedAfter: z.literal("refiner"),
  baselineHarness: ImmutableReleaseRefSchema,
  candidateHarness: ImmutableReleaseRefSchema,
  refiner: z.object({
    id: ReleaseIdSchema,
    contentHash: ReleaseHashSchema,
    outcomeCount: z.number().int().nonnegative(),
  }).strict(),
  usage: ModelEvaluationUsageSchema,
  budget: z.object({
    maximumSpendUsd: z.number().nonnegative(),
    observedSpendUsd: z.number().nonnegative(),
    enforced: z.boolean(),
  }).strict(),
  evidenceSnapshot: ImmutableReleaseRefSchema,
  attempts: z.array(ModelEvaluationAttemptSchema).max(10_000),
  contentHash: ReleaseHashSchema,
}).strict();

const ConfidenceIntervalSchema = z.object({
  level: z.literal(0.95),
  lower: z.number().finite(),
  upper: z.number().finite(),
}).strict().superRefine((interval, context) => {
  if (interval.lower > interval.upper) {
    context.addIssue({ code: "custom", message: "A confidence interval's lower bound cannot exceed its upper bound." });
  }
});

export const ModelComparisonBenchmarkReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.modelComparisonBenchmarkReceipt.v1"),
  benchmarkId: z.literal("model-comparison"),
  target: z.object({
    kind: z.enum(["base_model", "model_version", "external_reference"]),
    label: z.string().trim().min(1).max(300),
    modelVersionId: ReleaseIdSchema.nullable(),
    model: ChatModelRefSchema.nullable(),
  }).strict(),
  taskset: VersionedReleaseRefSchema,
  grader: ImmutableReleaseRefSchema,
  sampling: z.object({
    seeds: z.array(z.number().int()).min(1).max(100),
    repetitions: z.number().int().positive().max(20),
  }).strict(),
  deterministic: z.object({
    attemptedTaskCount: z.number().int().nonnegative(),
    completedTaskCount: z.number().int().nonnegative(),
    passedTaskCount: z.number().int().nonnegative(),
    failedTaskCount: z.number().int().nonnegative(),
    meanScore: z.number().finite().nullable(),
    passRate: z.number().min(0).max(1).nullable(),
    passRateCi95: ConfidenceIntervalSchema.nullable(),
  }).strict(),
  judge: z.object({
    judgeModel: ChatModelRefSchema,
    judgeRelease: ImmutableReleaseRefSchema,
    rubricRelease: ImmutableReleaseRefSchema,
    calibrationRelease: ImmutableReleaseRefSchema,
    score: z.number().min(0).max(100),
    scoreCi95: ConfidenceIntervalSchema,
    comparisonCount: z.number().int().positive(),
    wins: z.number().int().nonnegative(),
    ties: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    referenceLabel: z.string().trim().min(1).max(300),
  }).strict().superRefine((judge, context) => {
    if (judge.wins + judge.ties + judge.losses !== judge.comparisonCount) {
      context.addIssue({ code: "custom", message: "Judge win, tie, and loss counts must equal comparisonCount." });
    }
  }).nullable(),
  attempts: z.array(z.object({
    attemptId: ReleaseIdSchema.nullable().default(null),
    taskId: ReleaseIdSchema,
    seed: z.number().int(),
    repetition: z.number().int().nonnegative(),
    status: z.enum(["succeeded", "failed"]),
    deterministicScore: z.number().finite().nullable(),
    passed: z.boolean().nullable(),
    judgeScore: z.number().min(0).max(100).nullable(),
    judgePreference: z.enum(["win", "tie", "loss"]).nullable(),
    transcriptHash: ReleaseHashSchema.nullable(),
    traceHash: ReleaseHashSchema.nullable(),
    transcriptArtifact: z.object({
      artifactPath: z.string().trim().min(1).max(2_000),
      jsonPointer: z.string().trim().min(1).max(1_000),
    }).strict().nullable().default(null),
    traceArtifact: z.object({
      artifactPath: z.string().trim().min(1).max(2_000),
      jsonPointer: z.string().trim().min(1).max(1_000),
    }).strict().nullable().default(null),
    latencyMs: z.number().int().nonnegative().nullable().default(null),
    failureClass: TaskFailureClassSchema.nullable(),
  }).strict()).max(100_000),
  usage: z.object({
    policy: EvaluationUsageCategorySchema.nullable(),
    judge: EvaluationUsageCategorySchema.nullable(),
    observedSpendUsd: z.number().nonnegative().nullable(),
    evaluationGpuSeconds: z.number().nonnegative().nullable().default(null),
  }).strict(),
  managedServing: z.object({
    jobId: ReleaseIdSchema,
    terminalState: z.enum(["completed", "cancelled", "failed", "budget_exhausted"]),
    sourcePolicyVersion: z.number().int().nonnegative(),
    sourceAdapterSha256: ReleaseHashSchema.nullable(),
    servedPolicyVersion: z.number().int().nonnegative().nullable(),
    servedAdapterSha256: ReleaseHashSchema.nullable(),
    accruedSpendUsd: z.number().nonnegative(),
    cleanupAttestationHash: ReleaseHashSchema,
    resourceCount: z.number().int().nonnegative(),
    activeResourceCount: z.literal(0),
  }).strict().nullable().default(null),
  evidenceSnapshot: z.object({
    id: ReleaseIdSchema,
    contentHash: ReleaseHashSchema,
    artifactPath: z.string().trim().min(1).max(2_000),
  }).strict(),
  completedAt: ReleaseTimestampSchema,
  contentHash: ReleaseHashSchema,
}).strict().superRefine((receipt, context) => {
  const deterministic = receipt.deterministic;
  if (deterministic.completedTaskCount > deterministic.attemptedTaskCount) {
    context.addIssue({ code: "custom", message: "Completed task count cannot exceed attempted task count." });
  }
  if (deterministic.passedTaskCount + deterministic.failedTaskCount !== deterministic.completedTaskCount) {
    context.addIssue({ code: "custom", message: "Passed and failed task counts must equal completed task count." });
  }
  if ((deterministic.completedTaskCount === 0) !== (deterministic.meanScore === null)) {
    context.addIssue({ code: "custom", message: "Deterministic mean score is available exactly when tasks completed." });
  }
  if ((deterministic.completedTaskCount === 0) !== (deterministic.passRate === null)) {
    context.addIssue({ code: "custom", message: "Deterministic pass rate is available exactly when tasks completed." });
  }
});

const HarnessRefinerEvaluationConfigurationSchema = z.object({
  benchmarkId: z.literal("harness-refiner"),
  model: ChatModelRefSchema,
  upstreamModel: z.object({
    providerId: ReleaseIdSchema,
    modelId: z.string().trim().min(1).max(300),
    revision: z.string().trim().min(1).max(300),
    pricing: z.object({
      version: z.string().trim().min(1).max(300),
      source: z.string().trim().min(1).max(300),
      effectiveAt: ReleaseTimestampSchema,
      inputUsdPerMillionTokens: z.number().nonnegative(),
      cachedInputUsdPerMillionTokens: z.number().nonnegative(),
      outputUsdPerMillionTokens: z.number().nonnegative(),
    }).strict().optional(),
  }).strict(),
  reasoningEffort: z.string().trim().min(1).max(100).nullable(),
  seeds: z.array(z.number().int()).min(1).max(100),
  repetitions: z.number().int().positive().max(20),
  maximumSpendUsd: z.number().nonnegative(),
  attemptPlan: z.array(z.object({
    stage: z.enum(["baseline", "adaptation", "candidate_adaptation", "candidate"]),
    split: z.string().trim().min(1).max(100),
    taskIds: z.array(ReleaseIdSchema).min(1).max(100_000),
    attemptCount: z.number().int().positive(),
  }).strict()).length(4),
}).strict();

const ModelComparisonEvaluationConfigurationSchema = z.object({
  benchmarkId: z.literal("model-comparison"),
  target: z.object({
    kind: z.enum(["base_model", "model_version", "external_reference"]),
    label: z.string().trim().min(1).max(300),
    modelVersionId: ReleaseIdSchema.nullable(),
    model: ChatModelRefSchema.nullable(),
  }).strict(),
  grader: ImmutableReleaseRefSchema,
  judge: z.object({
    model: ChatModelRefSchema,
    release: ImmutableReleaseRefSchema,
    rubricRelease: ImmutableReleaseRefSchema,
    calibrationRelease: ImmutableReleaseRefSchema,
    referenceLabel: z.string().trim().min(1).max(300),
  }).strict().nullable(),
  seeds: z.array(z.number().int()).min(1).max(100),
  repetitions: z.number().int().positive().max(20),
  maximumSpendUsd: z.number().nonnegative(),
  series: z.object({
    id: ReleaseIdSchema,
    protocol: z.object({ id: ReleaseIdSchema, revision: z.number().int().positive(), contentHash: ReleaseHashSchema }).strict(),
  }).strict().nullable().default(null),
  panel: z.object({
    id: ReleaseIdSchema,
    role: z.enum(["correction", "sibling_verification", "cumulative_known", "development", "retained", "frozen_final"]),
    passLabel: ReleaseIdSchema.nullable(),
  }).strict().nullable().default(null),
  comparisonPair: z.object({
    entryId: ReleaseIdSchema,
    parent: ModelComparisonParentSchema,
    candidateModelVersionId: ReleaseIdSchema,
  }).strict().nullable().default(null),
  attemptPlan: z.array(z.object({
    stage: z.literal("comparison"),
    split: z.string().trim().min(1).max(100),
    taskIds: z.array(ReleaseIdSchema).min(1).max(100_000),
    attemptCount: z.number().int().positive(),
  }).strict()).length(1),
}).strict();

export const ModelEvaluationConfigurationSchema = z.union([
  HarnessRefinerEvaluationConfigurationSchema,
  ModelComparisonEvaluationConfigurationSchema,
]);

export const ModelRunSchema = z
  .object({
    schemaVersion: z.literal("openpond.modelRun.v1"),
    id: ReleaseIdSchema,
    modelId: ReleaseIdSchema,
    modelVersionId: ReleaseIdSchema.nullable(),
    profileId: ReleaseIdSchema,
    kind: z.enum(["rollout_smoke", "training", "evaluation"]),
    status: z.enum([
      "prepared",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ]),
    method: z.enum([
      "sft",
      "dpo",
      "grpo",
      "ppo",
      "sdft",
      "opd",
      "opsd",
      "sdpo",
    ]).nullable(),
    destinationId: ReleaseIdSchema.nullable(),
    taskset: VersionedReleaseRefSchema,
    comparisonSeriesEntry: ModelComparisonEntryRefSchema.nullable().optional(),
    harnessRelease: ImmutableReleaseRefSchema.nullable().optional(),
    quote: z
      .object({
        maximumSpendUsd: z.number().nonnegative(),
        hourlyCostUsd: z.number().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    evaluation: ModelEvaluationConfigurationSchema.nullable().default(null),
    evaluationProgress: z.object({
      stage: z.enum([
        "baseline",
        "adaptation",
        "refiner",
        "candidate_adaptation",
        "candidate",
        "comparison",
      ]),
      completedAttempts: z.number().int().nonnegative(),
      totalAttempts: z.number().int().positive(),
      accounting: ModelEvaluationAccountingSchema.nullable().default(null),
      evidenceSnapshot: ModelEvaluationEvidenceSnapshotSchema.nullable().default(null),
    }).strict().nullable().default(null),
    reward: z
      .object({
        raw: z.number(),
        components: z.record(z.string(), z.number()),
      })
      .strict()
      .nullable(),
    receipt: z.union([
      ModelRunReceiptSchema,
      ModelEvaluationReceiptSchema,
      ModelEvaluationStopReceiptSchema,
      ModelComparisonBenchmarkReceiptSchema,
    ]).nullable(),
    adapterArtifactLineageId: ReleaseIdSchema.nullable(),
    failure: z.string().trim().min(1).max(5_000).nullable(),
    startedAt: ReleaseTimestampSchema,
    completedAt: ReleaseTimestampSchema.nullable(),
    updatedAt: ReleaseTimestampSchema,
  })
  .strict()
  .superRefine((run, context) => {
    if (run.status === "succeeded" && !run.receipt) {
      context.addIssue({
        code: "custom",
        message: "A successful Model Run requires a canonical receipt.",
      });
    }
    if (
      run.kind === "evaluation"
      && (
        run.method !== null
        || run.destinationId !== null
        || !run.evaluation
        || run.adapterArtifactLineageId !== null
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An evaluation Model Run requires evaluation configuration and cannot claim training method, destination, or adapter lineage.",
      });
    }
    if (
      run.kind === "evaluation"
      && run.receipt
      && run.receipt.schemaVersion !== "openpond.modelEvaluationReceipt.v1"
      && run.receipt.schemaVersion !== "openpond.modelEvaluationStopReceipt.v1"
      && run.receipt.schemaVersion !== "openpond.modelComparisonBenchmarkReceipt.v1"
    ) {
      context.addIssue({
        code: "custom",
        message: "An evaluation Model Run requires an evaluation receipt.",
      });
    }
    if (
      run.kind !== "evaluation"
      && (run.method === null || run.destinationId === null || run.quote === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A training or rollout Model Run requires method, destination, and quote.",
      });
    }
    if (
      run.kind === "rollout_smoke"
      && run.adapterArtifactLineageId !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "A rollout smoke cannot claim adapter artifacts.",
      });
    }
  });

export type ModelVersionKind = z.infer<typeof ModelVersionKindSchema>;
export type ModelVersion = z.infer<typeof ModelVersionSchema>;
export type RewardModelVersion = z.infer<typeof RewardModelVersionSchema>;
export type RewardModelRunReceipt = z.infer<typeof RewardModelRunReceiptSchema>;
export type RewardModelRun = z.infer<typeof RewardModelRunSchema>;
export type ModelRunReceipt = z.infer<typeof ModelRunReceiptSchema>;
export type ModelEvaluationReceipt = z.infer<typeof ModelEvaluationReceiptSchema>;
export type ModelEvaluationStopReceipt = z.infer<typeof ModelEvaluationStopReceiptSchema>;
export type ModelComparisonBenchmarkReceipt = z.infer<typeof ModelComparisonBenchmarkReceiptSchema>;
export type ModelEvaluationConfiguration = z.infer<typeof ModelEvaluationConfigurationSchema>;
export type ModelRun = z.infer<typeof ModelRunSchema>;
export type ModelEvaluationAttempt = z.infer<typeof ModelEvaluationAttemptSchema>;
export type ModelEvaluationTaskEfficiency = z.infer<
  typeof ModelEvaluationTaskEfficiencySchema
>;
export type ModelEvaluationTaskEfficiencyPair = {
  cohort: "adaptation" | "held_out";
  taskId: string;
  baseline: ModelEvaluationAttempt;
  refined: ModelEvaluationAttempt;
  tokenDelta: number;
};

export function summarizeModelEvaluationTaskEfficiency(input: {
  attempts: readonly ModelEvaluationAttempt[];
  targetTaskCount?: number;
}): {
  summary: ModelEvaluationTaskEfficiency;
  pairs: ModelEvaluationTaskEfficiencyPair[];
} {
  const selected = new Map<string, ModelEvaluationAttempt>();
  for (const attempt of input.attempts) {
    const key = `${attempt.phase}\u0000${attempt.taskId}`;
    const current = selected.get(key);
    if (
      !current
      || attempt.startedAt > current.startedAt
      || (
        attempt.startedAt === current.startedAt
        && attempt.attemptId > current.attemptId
      )
    ) {
      selected.set(key, attempt);
    }
  }
  const attempts = [...selected.values()];
  const pairs = ([
    ["adaptation", "adaptation", "candidate_adaptation"],
    ["held_out", "baseline", "candidate"],
  ] as const).flatMap(([cohort, baselinePhase, refinedPhase]) => {
    const refinedByTask = new Map(
      attempts
        .filter((attempt) => attempt.phase === refinedPhase)
        .map((attempt) => [attempt.taskId, attempt]),
    );
    return attempts
      .filter((attempt) => attempt.phase === baselinePhase)
      .flatMap((baseline) => {
        const refined = refinedByTask.get(baseline.taskId);
        return refined ? [{
          cohort,
          taskId: baseline.taskId,
          baseline,
          refined,
          tokenDelta: refined.totalTokens - baseline.totalTokens,
        }] : [];
      });
  });
  const defaultTargetTaskCount = new Set(
    attempts
      .filter((attempt) => attempt.phase === "baseline" || attempt.phase === "adaptation")
      .map((attempt) => attempt.taskId),
  ).size;
  const targetTaskCount = input.targetTaskCount ?? defaultTargetTaskCount;
  if (!Number.isInteger(targetTaskCount) || targetTaskCount < 0) {
    throw new Error("Benchmark task-efficiency target must be a non-negative integer.");
  }
  const cohortTargetTaskCount = {
    adaptation: new Set(
      attempts
        .filter((attempt) => attempt.phase === "adaptation")
        .map((attempt) => attempt.taskId),
    ).size,
    held_out: new Set(
      attempts
        .filter((attempt) => attempt.phase === "baseline")
        .map((attempt) => attempt.taskId),
    ).size,
  };
  const summarizePairs = (
    items: ModelEvaluationTaskEfficiencyPair[],
    cohortTarget: number,
  ) => ({
    targetTaskCount: cohortTarget,
    comparedTaskCount: items.length,
    passedTaskCount: items.filter((pair) => pair.tokenDelta < 0).length,
    failedTaskCount: items.filter((pair) => pair.tokenDelta >= 0).length,
    lowerTaskCount: items.filter((pair) => pair.tokenDelta < 0).length,
    higherTaskCount: items.filter((pair) => pair.tokenDelta > 0).length,
    unchangedTaskCount: items.filter((pair) => pair.tokenDelta === 0).length,
  });
  const counts = summarizePairs(pairs, targetTaskCount);
  const baselineTokens = pairs.reduce(
    (sum, pair) => sum + pair.baseline.totalTokens,
    0,
  );
  const refinedTokens = pairs.reduce(
    (sum, pair) => sum + pair.refined.totalTokens,
    0,
  );
  const tokenDelta = refinedTokens - baselineTokens;
  const complete = pairs.length === targetTaskCount;
  const summary = ModelEvaluationTaskEfficiencySchema.parse({
    target: "all_tasks_lower",
    ...counts,
    baselineTokens,
    refinedTokens,
    tokenDelta,
    tokenDeltaPercent: baselineTokens > 0
      ? (tokenDelta / baselineTokens) * 100
      : null,
    complete,
    passed: complete && counts.passedTaskCount === targetTaskCount,
    cohorts: {
      adaptation: summarizePairs(
        pairs.filter((pair) => pair.cohort === "adaptation"),
        cohortTargetTaskCount.adaptation,
      ),
      heldOut: summarizePairs(
        pairs.filter((pair) => pair.cohort === "held_out"),
        cohortTargetTaskCount.held_out,
      ),
    },
  });
  return { summary, pairs };
}
