import { z } from "zod";
import type {
  BenchmarkComparison,
  BenchmarkRunSummary,
  EvaluationResult,
} from "@openpond/evals";
import {
  ModelProjectSchema as PublicModelProjectSchema,
  ModelProjectTrainingSetupSchema as PublicModelProjectTrainingSetupSchema,
} from "openpond-sdk/model-projects";
import {
  BaseModelPreferenceSchema,
  GraderAuditReportSchema,
  GradeResultSchema,
  TaskAttemptArtifactSchema,
  TaskAttemptResultSchema,
  TaskCreationSnapshotSchema,
  TasksetSchema,
  TrainingMethodReadinessReasonCodeSchema,
  TrainingSourceRefSchema,
} from "./tasksets.js";
import { TasksetDraftSchema } from "./taskset-drafts.js";
import {
  TaskCandidateSchema,
  TaskMinerConfigSchema,
  TaskMinerRunSchema,
} from "./task-mining.js";
import { DatasetArtifactSummarySchema } from "./dataset-artifacts.js";
import { DatasetImportJobSchema } from "./dataset-imports.js";
import {
  ModelRunSchema,
  ModelVersionSchema,
  RewardModelRunSchema,
  RewardModelVersionSchema,
} from "./model-lifecycle.js";
import {
  ModelComparisonEntryRefSchema,
  ModelComparisonSeriesEntrySchema,
  ModelComparisonSeriesSchema,
} from "./model-comparisons.js";
import {
  LearnedPreferenceRewardBindingSchema,
  PolicyOptimizationBudgetSchema,
  PolicyOptimizationContractSchema,
  PolicyOptimizerSchema,
  PpoOptimizerSchema,
  RftLossMethodSchema,
  TrainingModelRefSchema,
} from "./training-policy-optimization.js";
import {
  DEFAULT_LOCAL_MODEL_CHAT_CONFIGURATION,
  LocalModelChatConfigurationSchema,
  ManagedAdapterServingProjectionSchema,
} from "./training-managed-adapter.js";
import {
  TrainingHashSchema as HashSchema,
  TrainingIdSchema as IdSchema,
  TrainingMetadataSchema as MetadataSchema,
  TrainingTimestampSchema as TimestampSchema,
} from "./training-schema-primitives.js";
import { RolloutTrajectoryReceiptSchema } from "./training-trajectories.js";
import { ImmutableReleaseRefSchema } from "./release-core.js";
export * from "./training-managed-adapter.js";
export * from "./training-trajectories.js";
export {
  GrpoOptimizerSchema,
  LearnedPreferenceRewardBindingSchema,
  PolicyOptimizationBudgetSchema,
  PolicyOptimizationContractSchema,
  PolicyOptimizerSchema,
  PpoOptimizerSchema,
  RftLossMethodSchema,
  TrainingModelRefSchema,
} from "./training-policy-optimization.js";

export const DATASET_EXACT_ANSWER_ENVIRONMENT_ID =
  "dataset-exact-answer" as const;
export const DATASET_EXACT_ANSWER_ENVIRONMENT_VERSION =
  "dataset-exact-answer-v1" as const;
export const DATASET_NO_TOOLS_CONTRACT_HASH = "no-tools-v1" as const;
export const TrainingMethodSchema = z.enum([
  "sft",
  "dpo",
  "grpo",
  "ppo",
  "sdft",
  "opd",
  "opsd",
  "sdpo",
]);
export const TrainingParameterizationSchema = z.enum(["lora", "full"]);
export const TrainingDestinationIdSchema = z.enum([
  "openpond_managed",
]);

export const SftRecipeSchema = z.object({
  schemaVersion: z.literal("openpond.sftRecipe.v1"),
  method: z.literal("sft"),
  parameterization: z.literal("lora"),
  baseModel: z.object({
    id: IdSchema,
    revision: z.string().trim().min(1).max(256),
    tokenizerRevision: z.string().trim().min(1).max(256),
    chatTemplateHash: HashSchema,
  }),
  dataset: z.object({
    trainSplit: z.literal("train"),
    validationSplit: z.enum(["validation", "frozen_eval"]),
    completionOnly: z.boolean(),
    maxSequenceLength: z.number().int().positive().max(32_768),
    maxExamples: z.number().int().positive().max(100_000).default(1_000),
    selectionStrategy: z
      .literal("stable_hash_top_n")
      .default("stable_hash_top_n"),
    selectionSeed: z.number().int().default(17),
  }),
  lora: z.object({
    rank: z.number().int().positive().max(256),
    alpha: z.number().positive().max(1_024),
    dropout: z.number().min(0).max(1),
    targetModules: z.array(IdSchema).min(1).max(100),
  }),
  optimizer: z.object({
    learningRate: z.number().positive(),
    epochs: z.number().positive().max(100),
    maxSteps: z.number().int().positive().max(1_000_000),
    batchSize: z.number().int().positive().max(10_000),
    gradientAccumulationSteps: z.number().int().positive().max(10_000),
    seed: z.number().int(),
  }),
  resourceLimits: z.object({
    cpuThreads: z.number().int().positive().max(256),
    memoryBytes: z.number().int().positive(),
    wallTimeMs: z.number().int().positive(),
  }),
});

export const SftTrainingRecordSchema = z.object({
  id: IdSchema,
  input: z.record(z.string(), z.unknown()),
  expectedOutput: z.record(z.string(), z.unknown()),
  tags: z.array(IdSchema).max(100).default([]),
});

export const DpoTrainingRecordSchema = z.object({
  id: IdSchema,
  prompt: z.string().min(1).max(500_000),
  chosen: z.string().min(1).max(500_000),
  rejected: z.string().min(1).max(500_000),
  sourceRefs: z.array(IdSchema).min(1).max(10_000),
});

export const PolicyTrainingRecordSchema = z.object({
  id: IdSchema,
  input: z.record(z.string(), z.unknown()),
  tags: z.array(IdSchema).max(100).default([]),
});

export const RewardModelRecipeSchema = z.object({
  schemaVersion: z.literal("openpond.rewardModelRecipe.v1"),
  method: z.literal("reward_model"),
  parameterization: z.literal("lora_with_scalar_head"),
  runScope: z.enum(["synthetic_smoke", "human_preference"]),
  baseModel: z.object({
    id: IdSchema,
    revision: z.string().trim().min(1).max(256),
    tokenizerRevision: z.string().trim().min(1).max(256),
    processorRevision: z.string().trim().min(1).max(256),
    chatTemplateHash: HashSchema,
  }).strict(),
  tasksetRelease: ImmutableReleaseRefSchema,
  preferenceDatasetRelease: ImmutableReleaseRefSchema,
  processorRelease: ImmutableReleaseRefSchema,
  input: z.object({
    kind: z.literal("structured_text"),
    serialization: z.enum([
      "scenario_input_and_candidate_json_v1",
      "visible_agent_trajectory_v1",
    ]),
    maxCharacters: z.number().int().positive().max(500_000),
  }).strict().default({
    kind: "structured_text",
    serialization: "scenario_input_and_candidate_json_v1",
    maxCharacters: 32_000,
  }),
  lora: z.object({
    rank: z.number().int().positive().max(256),
    alpha: z.number().positive().max(1_024),
    dropout: z.number().min(0).max(1),
    targetModules: z.array(IdSchema).min(1).max(100),
  }).strict(),
  heads: z.object({
    scalar: z.literal("pooled_hidden_state_linear"),
    bucket: z.enum(["none", "three_class"]).default("three_class"),
  }).strict(),
  loss: z.object({
    ranking: z.literal("bradley_terry"),
    rankingWeight: z.number().positive(),
    bucketWeight: z.number().nonnegative(),
    tieWeight: z.number().nonnegative(),
  }).strict(),
  optimizer: z.object({
    learningRate: z.number().positive(),
    maxSteps: z.number().int().positive().max(100_000),
    batchSize: z.number().int().positive().max(10_000),
    gradientAccumulationSteps: z.number().int().positive().max(10_000),
    seed: z.number().int(),
    checkpointEverySteps: z.number().int().positive().max(100_000),
  }).strict(),
  resourceLimits: z.object({
    wallTimeMs: z.number().int().positive().max(24 * 60 * 60 * 1_000),
    maxExamples: z.number().int().positive().max(100_000),
    maxInputCharacters: z.number().int().positive().max(500_000).default(32_000),
    maxImagePixels: z.number().int().positive().max(100_000_000).optional(),
    maximumSpendUsd: z.number().nonnegative().max(100_000),
  }).strict(),
}).superRefine((recipe, context) => {
  if (
    recipe.runScope === "synthetic_smoke"
    && (recipe.optimizer.maxSteps > 100 || recipe.resourceLimits.maximumSpendUsd > 10)
  ) {
    context.addIssue({
      code: "custom",
      path: ["resourceLimits"],
      message: "Synthetic-smoke Reward Model runs are limited to 100 steps and USD 10.",
    });
  }
});

export const RftRecipeSchema = z.object({
  schemaVersion: z.literal("openpond.rftRecipe.v1"),
  method: z.literal("grpo"),
  parameterization: z.literal("lora"),
  baseModel: z.object({
    id: IdSchema,
    revision: z.string().trim().min(1).max(256),
    tokenizerRevision: z.string().trim().min(1).max(256),
    chatTemplateHash: HashSchema,
  }),
  dataset: z.object({
    trainSplit: z.literal("train"),
    validationSplit: z.enum(["validation", "frozen_eval"]),
    maxPromptTokens: z.number().int().positive().max(32_768),
    maxExamples: z.number().int().positive().max(100_000).default(1_000),
    selectionStrategy: z
      .enum(["stable_hash_top_n", "rft_easy_curriculum_v1"])
      .default("stable_hash_top_n"),
  }),
  lora: z.object({
    rank: z.number().int().positive().max(256),
  }),
  rollout: z.object({
    groupSize: z.number().int().min(2).max(64),
    concurrency: z.number().int().positive().max(32),
    maxTurns: z.number().int().positive().max(100),
    maxOutputTokens: z.number().int().positive().max(8_192),
    temperature: z.number().min(0).max(2),
    topP: z.number().positive().max(1),
    seed: z.number().int(),
  }),
  optimizer: z.object({
    learningRate: z.number().positive(),
    maxSteps: z.number().int().positive().max(100_000),
    clipRange: z.number().positive().max(1).default(0.2),
    iterations: z.number().int().min(2).max(16).default(2),
    microbatchSize: z.number().int().positive().max(64).default(1),
    gradientAccumulationSteps: z.number().int().positive().max(64).default(1),
    advantageEpsilon: z.number().positive().max(0.01).default(1e-8),
  }),
  loss: z
    .object({
      method: RftLossMethodSchema.default("grpo"),
      klBeta: z.number().min(0).nullable().default(null),
    })
    .default({ method: "grpo", klBeta: null }),
  reward: z.object({
    graderId: IdSchema,
    graderHash: HashSchema,
    environmentId: IdSchema,
    environmentVersion: z.string().trim().min(1).max(256),
    toolContractHash: HashSchema,
    learnedPreference: LearnedPreferenceRewardBindingSchema.nullable().optional(),
  }),
  resourceLimits: z.object({
    wallTimeMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1_000),
    maxRollouts: z.number().int().positive().max(100_000),
    maxPayloadBytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024),
  }),
  policyOptimization: PolicyOptimizationContractSchema.nullable().default(null),
  continuation: z
    .object({
      schemaVersion: z.literal("openpond.crossJobContinuationRequest.v1"),
      parentArtifact: ImmutableReleaseRefSchema,
      sourceArtifact: z
        .object({
          jobId: IdSchema,
          artifactId: IdSchema,
          checkpointId: IdSchema,
          contentHash: HashSchema,
        })
        .strict(),
      optimizerMode: z.enum(["continue", "reset"]),
    })
    .strict()
    .optional(),
});

export const DpoRecipeSchema = z.object({
  schemaVersion: z.literal("openpond.dpoRecipe.v1"),
  method: z.literal("dpo"),
  parameterization: z.literal("lora"),
  policyModel: TrainingModelRefSchema,
  referenceModel: TrainingModelRefSchema,
  dataset: z.object({
    trainSplit: z.literal("train"),
    validationSplit: z.enum(["validation", "frozen_eval"]),
    maxPairs: z.number().int().positive().max(100_000),
    maxPromptTokens: z.number().int().positive().max(32_768),
    maxCompletionTokens: z.number().int().positive().max(32_768),
    selectionStrategy: z.literal("stable_hash_top_n"),
    selectionSeed: z.number().int(),
  }),
  lora: z.object({
    rank: z.number().int().positive().max(256),
    alpha: z.number().positive().max(1_024),
    dropout: z.number().min(0).max(1),
    targetModules: z.array(IdSchema).min(1).max(100),
  }),
  loss: z.object({
    variant: z.literal("sigmoid"),
    beta: z.number().positive().max(10),
    labelSmoothing: z.number().min(0).max(0.5).default(0),
  }),
  optimizer: z.object({
    learningRate: z.number().positive(),
    epochs: z.number().positive().max(100),
    maxSteps: z.number().int().positive().max(1_000_000),
    batchSize: z.number().int().positive().max(10_000),
    gradientAccumulationSteps: z.number().int().positive().max(10_000),
    seed: z.number().int(),
  }),
  referenceLogprobs: z.object({
    cacheSchemaVersion: z.literal("openpond.dpoReferenceLogprobs.v1"),
    cacheKey: HashSchema,
    invalidationHash: HashSchema,
  }),
  resourceLimits: z.object({
    cpuThreads: z.number().int().positive().max(256),
    memoryBytes: z.number().int().positive(),
    wallTimeMs: z.number().int().positive(),
  }),
});

export const PpoRecipeSchema = z.object({
  schemaVersion: z.literal("openpond.ppoRecipe.v1"),
  method: z.literal("ppo"),
  parameterization: z.literal("lora"),
  policyOptimization: PolicyOptimizationContractSchema.extend({
    optimizer: PpoOptimizerSchema,
  }),
  lora: z.object({
    rank: z.number().int().positive().max(256),
    alpha: z.number().positive().max(1_024),
    dropout: z.number().min(0).max(1),
    targetModules: z.array(IdSchema).min(1).max(100),
  }),
  valueHead: z.object({
    initialization: z.literal("policy_hidden_state_linear"),
    optimizerLearningRate: z.number().positive(),
    artifactName: z.literal("value_head.safetensors"),
  }),
  policyLearningRate: z.number().positive(),
  resume: z.object({
    checkpointId: IdSchema.nullable(),
    policyHash: HashSchema,
    referenceHash: HashSchema,
    valueModelHash: HashSchema,
    optimizerStateHash: HashSchema.nullable(),
  }),
  resourceLimits: z.object({
    cpuThreads: z.number().int().positive().max(256),
    memoryBytes: z.number().int().positive(),
    wallTimeMs: z.number().int().positive(),
  }),
});

export const UnsupportedTrainingRecipeSchema = z.object({
  schemaVersion: z.literal("openpond.unsupportedRecipe.v1"),
  method: TrainingMethodSchema.exclude(["sft", "dpo", "grpo", "ppo"]),
  parameterization: TrainingParameterizationSchema,
  unsupportedReason: z.string().trim().min(1).max(5_000),
});
export const TrainingRecipeSchema = z.union([
  SftRecipeSchema,
  DpoRecipeSchema,
  RftRecipeSchema,
  PpoRecipeSchema,
  UnsupportedTrainingRecipeSchema,
]);

export const TrainingDestinationCapabilitiesSchema = z.object({
  schemaVersion: z.literal("openpond.trainingDestinationCapabilities.v1"),
  destinationId: TrainingDestinationIdSchema,
  available: z.boolean(),
  methods: z.array(TrainingMethodSchema),
  parameterizations: z.array(TrainingParameterizationSchema),
  modelAllowlist: z.array(IdSchema).default([]),
  maxDatasetBytes: z.number().int().nonnegative().nullable(),
  environmentPlacements: z.array(
    z.enum(["none", "local", "remote", "colocated", "provider_native"])
  ),
  nonProduction: z.boolean(),
  unavailableReason: z.string().trim().min(1).max(5_000).nullable(),
  checkedAt: TimestampSchema,
});

export const BaseModelExecutionOptionSchema = z.object({
  destinationId: TrainingDestinationIdSchema,
  available: z.boolean(),
  methods: z.array(TrainingMethodSchema),
  parameterizations: z.array(TrainingParameterizationSchema),
  nonProduction: z.boolean(),
  unavailableReason: z.string().trim().min(1).max(5_000).nullable(),
});

export const BaseModelCandidateSchema = z.object({
  schemaVersion: z.literal("openpond.baseModelCandidate.v1"),
  selectionKey: IdSchema,
  label: z.string().trim().min(1).max(500),
  sourceLabel: z.string().trim().min(1).max(500),
  preference: BaseModelPreferenceSchema,
  available: z.boolean(),
  nonProduction: z.boolean(),
  unavailableReason: z.string().trim().min(1).max(5_000).nullable(),
  methods: z.array(TrainingMethodSchema),
  executionOptions: z.array(BaseModelExecutionOptionSchema).min(1),
});

export const TrainingCompatibilityIssueSchema = z.object({
  code: IdSchema,
  severity: z.enum(["warning", "error"]),
  path: z.string().trim().max(2_000).nullable(),
  message: z.string().trim().min(1).max(5_000),
});
export const TrainingCompatibilityReportSchema = z.object({
  schemaVersion: z.literal("openpond.trainingCompatibility.v1"),
  compatible: z.boolean(),
  destinationId: TrainingDestinationIdSchema,
  tasksetId: IdSchema,
  recipeMethod: TrainingMethodSchema,
  issues: z.array(TrainingCompatibilityIssueSchema),
  checkedAt: TimestampSchema,
});

export const TrainingMethodAvailabilityReasonCodeSchema = z.union([
  TrainingMethodReadinessReasonCodeSchema,
  z.enum([
    "destination_unavailable",
    "destination_method_unsupported",
    "destination_model_unsupported",
    "destination_parameterization_unsupported",
    "experimental_destination",
  ]),
]);

export const TrainingMethodAvailabilitySchema = z.object({
  method: TrainingMethodSchema,
  state: z.enum([
    "recommended",
    "compatible",
    "needs_dataset_work",
    "destination_unavailable",
    "experimental_destination",
  ]),
  reasonCodes: z.array(TrainingMethodAvailabilityReasonCodeSchema).default([]),
  reasons: z.array(z.string().trim().min(1).max(5_000)).default([]),
  destinationId: TrainingDestinationIdSchema.nullable().default(null),
});

export const ModelRunPresetSchema = z.enum([
  "small",
  "standard",
  "custom",
  "small_experiment",
]);

export const ModelProjectTrainingSetupSchema =
  PublicModelProjectTrainingSetupSchema;
export const ModelProjectSchema = PublicModelProjectSchema;

export const TrainingPlanSchema = z.object({
  schemaVersion: z.literal("openpond.trainingPlan.v1"),
  id: IdSchema,
  modelId: IdSchema,
  tasksetId: IdSchema,
  tasksetHash: HashSchema,
  comparisonSeriesEntry: ModelComparisonEntryRefSchema.nullable().optional(),
  harnessRelease: ImmutableReleaseRefSchema.nullable().optional(),
  modelImprovementQualification: ImmutableReleaseRefSchema.nullable().optional(),
  destinationId: TrainingDestinationIdSchema,
  recipe: TrainingRecipeSchema,
  environmentPlacement: z.enum([
    "none",
    "local",
    "remote",
    "colocated",
    "provider_native",
  ]),
  compatibility: TrainingCompatibilityReportSchema,
  dataPolicy: z.object({
    exportApproved: z.boolean(),
    approvedSourceIds: z.array(IdSchema),
    retentionDays: z.number().int().nonnegative().nullable(),
    region: z.string().trim().min(1).max(200).nullable(),
  }),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  createdAt: TimestampSchema,
  contentHash: HashSchema,
});

export const TrainingBundleFileSchema = z.object({
  path: z.string().trim().min(1).max(2_000),
  sha256: HashSchema,
  sizeBytes: z.number().int().nonnegative(),
  role: z.enum([
    "manifest",
    "task_data",
    "grader",
    "environment",
    "recipe",
    "policy",
    "provenance",
  ]),
});
export const TrainingBundleManifestSchema = z.object({
  schemaVersion: z.literal("openpond.trainingBundle.v1"),
  id: IdSchema,
  planId: IdSchema,
  tasksetId: IdSchema,
  tasksetHash: HashSchema,
  recipeHash: HashSchema,
  files: z.array(TrainingBundleFileSchema).min(1).max(1_000_000),
  totalSizeBytes: z.number().int().nonnegative(),
  sourceIds: z.array(IdSchema),
  excludedSourceIds: z.array(IdSchema),
  containsRawChats: z.literal(false),
  containsSecrets: z.literal(false),
  containsHiddenGraderAssets: z.literal(false),
  createdAt: TimestampSchema,
  contentHash: HashSchema,
});

export const TrainingBundleExportSchema = z.object({
  schemaVersion: z.literal("openpond.trainingBundleExport.v1"),
  manifest: TrainingBundleManifestSchema,
  files: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(2_000),
        sha256: HashSchema,
        sizeBytes: z.number().int().nonnegative(),
        encoding: z.literal("base64"),
        content: z.string(),
      })
    )
    .min(1),
  contentHash: HashSchema,
});

export const TrainingPreparedStartSchema = z.object({
  schemaVersion: z.literal("openpond.trainingPreparedStart.v1"),
  plan: TrainingPlanSchema,
  bundle: TrainingBundleManifestSchema,
  approvalActor: IdSchema.nullable(),
  preparedAt: TimestampSchema,
});

export const TrainingApprovalSchema = z.object({
  schemaVersion: z.literal("openpond.trainingApproval.v1"),
  id: IdSchema,
  planId: IdSchema,
  bundleHash: HashSchema,
  harnessRelease: ImmutableReleaseRefSchema.nullable().optional(),
  modelImprovementQualification: ImmutableReleaseRefSchema.nullable().optional(),
  destinationId: TrainingDestinationIdSchema,
  modelId: IdSchema,
  method: TrainingMethodSchema,
  parameterization: TrainingParameterizationSchema,
  maximumCostUsd: z.number().nonnegative().nullable(),
  approvedBy: IdSchema,
  approvedAt: TimestampSchema,
});

/**
 * Immutable product lineage copied onto a Training Job when a Model Project
 * setup is submitted. Runtime reconciliation must read this snapshot instead
 * of mutable Project authoring state.
 */
export const TrainingJobSourceSnapshotSchema = z.object({
  schemaVersion: z.literal("openpond.trainingJobSourceSnapshot.v1"),
  modelProjectId: IdSchema,
  sourceProjectRevision: z.number().int().positive(),
  profileId: IdSchema,
  taskset: z.object({
    id: IdSchema,
    revision: z.number().int().positive(),
    contentHash: HashSchema,
  }).strict(),
  tasksetRelease: ImmutableReleaseRefSchema,
  harnessRelease: ImmutableReleaseRefSchema,
  baseModel: BaseModelPreferenceSchema,
  method: TrainingMethodSchema,
}).strict();

export const TrainingJobStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
  "reconciling",
]);
export const TrainingJobSchema = z.object({
  schemaVersion: z.literal("openpond.trainingJob.v1"),
  id: IdSchema,
  planId: IdSchema,
  bundleHash: HashSchema,
  approvalId: IdSchema,
  destinationId: TrainingDestinationIdSchema,
  status: TrainingJobStatusSchema,
  nonProduction: z.boolean(),
  workerPid: z.number().int().positive().nullable(),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  error: z.string().trim().min(1).max(20_000).nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  metadata: MetadataSchema,
});

export const TrainingJobEventSchema = z.object({
  schemaVersion: z.literal("openpond.trainingJobEvent.v1"),
  id: IdSchema,
  jobId: IdSchema,
  sequence: z.number().int().nonnegative(),
  type: z.enum([
    "queued",
    "start",
    "progress",
    "metric",
    "checkpoint",
    "cancel",
    "complete",
    "failure",
    "reconcile",
  ]),
  timestamp: TimestampSchema,
  payload: MetadataSchema,
});

export const SftStepMetricSchema = z.object({
  schemaVersion: z.literal("openpond.sftStepMetric.v1"),
  step: z.number().int().nonnegative(),
  maxSteps: z.number().int().positive(),
  timestamp: TimestampSchema,
  epoch: z.number().nonnegative().nullable(),
  loss: z.number().nullable(),
  learningRate: z.number().nonnegative().nullable(),
  gradientNorm: z.number().nonnegative().nullable(),
  entropy: z.number().nonnegative().nullable(),
  meanTokenAccuracy: z.number().min(0).max(1).nullable(),
  preferenceAccuracy: z.number().min(0).max(1).nullable().default(null),
  preferenceMargin: z.number().nullable().default(null),
  chosenReward: z.number().nullable().default(null),
  rejectedReward: z.number().nullable().default(null),
  chosenLogProbability: z.number().nullable().default(null),
  rejectedLogProbability: z.number().nullable().default(null),
  reward: z.number().nullable().default(null),
  policyLoss: z.number().nullable().default(null),
  advantageLoss: z.number().nullable().default(null),
  inputTokensSeen: z.number().int().nonnegative().nullable(),
  memoryBytes: z.number().int().nonnegative().nullable(),
  elapsedSeconds: z.number().nonnegative().nullable(),
});

export const PolicyOptimizationMetricSchema = z.object({
  schemaVersion: z.literal("openpond.policyOptimizationMetric.v1"),
  method: z.enum(["grpo", "ppo"]),
  step: z.number().int().nonnegative(),
  timestamp: TimestampSchema,
  learningRate: z.number().nonnegative().nullable().default(null),
  policyLoss: z.number().nullable(),
  valueLoss: z.number().nullable(),
  gradientNorm: z.number().nonnegative().nullable().default(null),
  meanReward: z.number().nullable(),
  meanReturn: z.number().nullable(),
  kl: z.number().nullable(),
  behaviorPolicyKlPreUpdate: z.number().nonnegative().nullable().default(null),
  entropy: z.number().nullable(),
  policyClipFraction: z.number().min(0).max(1).nullable(),
  behaviorPolicyClipFractionPreUpdate: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .default(null),
  valueClipFraction: z.number().min(0).max(1).nullable(),
  explainedVariance: z.number().nullable(),
  rolloutLearnerLag: z.number().int().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  environmentExecutions: z.number().int().nonnegative(),
  trajectoryCount: z.number().int().nonnegative().nullable().default(null),
  costUsd: z.number().nonnegative().nullable(),
});

export const ManagedTrainingRunEvidenceSchema = z.object({
  schemaVersion: z.literal("openpond.managedTrainingRunEvidence.v2"),
  provider: IdSchema,
  providerRunId: IdSchema,
  state: IdSchema,
  progress: z.object({
    targetOptimizerSteps: z.number().int().nonnegative(),
    committedOptimizerSteps: z.number().int().nonnegative(),
    skippedOptimizerSteps: z.number().int().nonnegative(),
  }),
  reward: z.object({
    finalMean: z.number().nullable(),
    variance: z.number().nonnegative().nullable(),
    minimum: z.number().nullable(),
    maximum: z.number().nullable(),
    distinctValueCount: z.number().int().nonnegative(),
    noSignalGroupCount: z.number().int().nonnegative(),
    trajectoryCount: z.number().int().nonnegative(),
    eligibleTrajectoryCount: z.number().int().nonnegative(),
  }),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    environmentExecutions: z.number().int().nonnegative(),
  }),
  resource: z.object({
    provider: IdSchema,
    gpuType: z.string().trim().min(1).max(300).nullable(),
    gpuCount: z.number().int().nonnegative().nullable(),
    hourlyCostUsd: z.number().nonnegative().nullable(),
    durationSeconds: z.number().nonnegative().nullable(),
    gpuSeconds: z.number().nonnegative().nullable(),
  }),
  cost: z.object({
    totalUsd: z.number().nonnegative().nullable(),
  }),
  checkpoint: z
    .object({
      id: IdSchema,
      policyVersion: z.number().int().nonnegative(),
      sha256: HashSchema.nullable(),
      sizeBytes: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  movement: z.object({
    adapterDeltaNorm: z.number().nonnegative().nullable(),
  }),
  evaluations: z.array(
    z.object({
      kind: z.enum(["baseline", "candidate"]),
      policyVersion: z.number().int().nonnegative(),
      score: z.number().nullable(),
      threshold: z.number().nullable(),
      passed: z.boolean().nullable(),
    }),
  ),
  canonicalPublication: z.object({
    state: IdSchema.nullable(),
    artifactId: IdSchema.nullable(),
  }),
  syncedAt: TimestampSchema,
});

export const TrainingEvaluationAggregateSchema = z.object({
  count: z.number().int().nonnegative(),
  scoredCount: z.number().int().nonnegative(),
  meanScore: z.number().min(0).max(1).nullable(),
  passedCount: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1).nullable(),
});

export const TrainingEvaluationGradeSchema = z.object({
  status: z.enum(["scored", "unavailable"]),
  score: z.number().min(0).max(1).nullable(),
  passed: z.boolean(),
  rewardEligible: z.boolean(),
  failureClass: z
    .enum([
      "policy_failure",
      "grader_failure",
      "environment_failure",
      "infrastructure_failure",
      "timeout",
      "cancelled",
    ])
    .nullable(),
  feedback: z.array(z.string().trim().min(1).max(20_000)).max(1_000),
  components: z
    .array(
      z.object({
        graderId: IdSchema,
        score: z.number().min(0).max(1),
        passed: z.boolean(),
        feedback: z.string().trim().max(20_000).nullable(),
      })
    )
    .max(1_000),
});

export const TrainingEvaluationExampleSchema = z.object({
  taskId: IdSchema,
  input: z.record(z.string(), z.unknown()),
  baseOutput: z.record(z.string(), z.unknown()).nullable(),
  trainedOutput: z.record(z.string(), z.unknown()).nullable(),
  baseGrade: TrainingEvaluationGradeSchema.nullable(),
  trainedGrade: TrainingEvaluationGradeSchema.nullable(),
});

export const TrainingEvaluationSummarySchema = z.object({
  schemaVersion: z.literal("openpond.trainingEvaluationSummary.v1"),
  jobId: IdSchema,
  tasksetId: IdSchema,
  base: TrainingEvaluationAggregateSchema,
  trained: TrainingEvaluationAggregateSchema,
  meanScoreDelta: z.number().min(-1).max(1).nullable(),
  examples: z.array(TrainingEvaluationExampleSchema).max(1_000_000),
});

export const TrainingRunDetailSchema = z.object({
  schemaVersion: z.literal("openpond.trainingRunDetail.v1"),
  job: TrainingJobSchema,
  events: z.array(TrainingJobEventSchema),
  stepMetrics: z.array(SftStepMetricSchema),
  policyMetrics: z.array(PolicyOptimizationMetricSchema).default([]),
  managedEvidence: ManagedTrainingRunEvidenceSchema.nullable().default(null),
  evaluation: TrainingEvaluationSummarySchema.nullable(),
  generatedAt: TimestampSchema,
});

export const TrainingArtifactSchema = z.object({
  schemaVersion: z.literal("openpond.trainingArtifact.v1"),
  id: IdSchema,
  jobId: IdSchema,
  kind: z.enum([
    "adapter",
    "checkpoint",
    "metrics",
    "log",
    "manifest",
    "evaluation",
  ]),
  path: z.string().trim().min(1).max(4_000),
  sha256: HashSchema,
  sizeBytes: z.number().int().nonnegative(),
  baseModelId: IdSchema.nullable(),
  baseModelRevision: z.string().trim().min(1).max(256).nullable(),
  tokenizerRevision: z.string().trim().min(1).max(256).nullable(),
  chatTemplateHash: HashSchema.nullable(),
  nonProduction: z.boolean(),
  createdAt: TimestampSchema,
  metadata: MetadataSchema,
});

export const ModelArtifactLineageSchema = z.object({
  schemaVersion: z.literal("openpond.modelArtifactLineage.v1"),
  id: IdSchema,
  modelId: IdSchema,
  artifactId: IdSchema,
  jobId: IdSchema,
  tasksetId: IdSchema,
  tasksetHash: HashSchema,
  graderHash: HashSchema,
  planHash: HashSchema,
  bundleHash: HashSchema,
  recipeHash: HashSchema,
  workerVersion: z.string().trim().min(1).max(256),
  trainerVersion: z.string().trim().min(1).max(256),
  importedAt: TimestampSchema,
  frozenEvaluationArtifactId: IdSchema.nullable(),
  promotable: z.boolean(),
  pinned: z.boolean().default(false),
  status: z.enum(["imported", "rejected"]).default("imported"),
  rejectedAt: TimestampSchema.nullable().default(null),
  rejectionReason: z.string().trim().min(1).max(5_000).nullable().default(null),
  chatConfiguration: LocalModelChatConfigurationSchema.default(
    DEFAULT_LOCAL_MODEL_CHAT_CONFIGURATION
  ),
  managedServing:
    ManagedAdapterServingProjectionSchema.nullable().default(null),
});

export const ModelBindingRoleSchema = z.enum([
  "chat_manual",
  "agent",
  "extension",
  "authoring_optimizer",
]);

export const ModelBindingSchema = z.object({
  schemaVersion: z.literal("openpond.modelBinding.v1"),
  id: IdSchema,
  profileId: IdSchema,
  role: ModelBindingRoleSchema,
  roleTargetId: IdSchema,
  modelArtifactLineageId: IdSchema,
  tasksetId: IdSchema,
  evaluationArtifactId: IdSchema.nullable(),
  status: z.enum(["active", "rolled_back"]),
  priorBindingId: IdSchema.nullable(),
  rollbackTargetBindingId: IdSchema.nullable(),
  promotedBy: IdSchema,
  promotedAt: TimestampSchema,
  rolledBackAt: TimestampSchema.nullable(),
  metadata: MetadataSchema,
});

export const TrainingActivityResponseSchema = z.object({
  schemaVersion: z.literal("openpond.trainingActivity.v1"),
  profileId: IdSchema,
  active: z.boolean(),
  activeCounts: z.object({
    jobs: z.number().int().nonnegative(),
    creations: z.number().int().nonnegative(),
    minerRuns: z.number().int().nonnegative(),
    datasetImports: z.number().int().nonnegative(),
  }),
  revision: HashSchema,
  generatedAt: TimestampSchema,
});

export const TasksetOperationalStateSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetOperationalState.v1"),
  tasksetId: IdSchema,
  attempts: z.array(TaskAttemptResultSchema),
  artifacts: z.array(TaskAttemptArtifactSchema),
  grades: z.array(GradeResultSchema),
  generatedAt: TimestampSchema,
});

export const TrainingStateResponseSchema = z.object({
  schemaVersion: z.literal("openpond.trainingState.v1"),
  profileId: IdSchema,
  sources: z.array(TrainingSourceRefSchema),
  creations: z.array(TaskCreationSnapshotSchema),
  tasksetDrafts: z.array(TasksetDraftSchema).default([]),
  tasksets: z.array(TasksetSchema),
  benchmarkRuns: z.array(z.custom<BenchmarkRunSummary>()).default([]),
  benchmarkComparisons: z.array(z.custom<BenchmarkComparison>()).default([]),
  datasetImports: z.array(DatasetImportJobSchema).default([]),
  datasetArtifacts: z.array(DatasetArtifactSummarySchema).default([]),
  graderAuditReports: z.array(GraderAuditReportSchema),
  evaluationResults: z.array(z.custom<EvaluationResult>()).default([]),
  candidates: z.array(TaskCandidateSchema),
  minerConfig: TaskMinerConfigSchema,
  minerRuns: z.array(TaskMinerRunSchema).default([]),
  modelProjects: z.array(ModelProjectSchema).default([]),
  modelVersions: z.array(ModelVersionSchema).default([]),
  modelRuns: z.array(ModelRunSchema).default([]),
  comparisonSeries: z.array(ModelComparisonSeriesSchema).default([]),
  comparisonSeriesEntries: z.array(ModelComparisonSeriesEntrySchema).default([]),
  rewardModelVersions: z.array(RewardModelVersionSchema).default([]),
  rewardModelRuns: z.array(RewardModelRunSchema).default([]),
  modelTasksets: z.array(TasksetSchema).default([]),
  plans: z.array(TrainingPlanSchema),
  bundles: z.array(TrainingBundleManifestSchema),
  jobs: z.array(TrainingJobSchema),
  artifacts: z.array(TrainingArtifactSchema),
  models: z.array(ModelArtifactLineageSchema),
  rolloutReceipts: z.array(RolloutTrajectoryReceiptSchema).default([]),
  modelBindings: z.array(ModelBindingSchema).default([]),
  destinations: z.array(TrainingDestinationCapabilitiesSchema),
  baseModelCandidates: z.array(BaseModelCandidateSchema).default([]),
  activityRevision: HashSchema.optional(),
  generatedAt: TimestampSchema,
});

export type TrainingMethod = z.infer<typeof TrainingMethodSchema>;
export type TrainingDestinationId = z.infer<typeof TrainingDestinationIdSchema>;
export type RftLossMethod = z.infer<typeof RftLossMethodSchema>;
export type PolicyOptimizationBudget = z.infer<
  typeof PolicyOptimizationBudgetSchema
>;
export type PolicyOptimizer = z.infer<typeof PolicyOptimizerSchema>;
export type PolicyOptimizationContract = z.infer<
  typeof PolicyOptimizationContractSchema
>;
export type SftRecipe = z.infer<typeof SftRecipeSchema>;
export type DpoRecipe = z.infer<typeof DpoRecipeSchema>;
export type PpoRecipe = z.infer<typeof PpoRecipeSchema>;
export type RftRecipe = z.infer<typeof RftRecipeSchema>;
export type RewardModelRecipe = z.infer<typeof RewardModelRecipeSchema>;
export type LearnedPreferenceRewardBinding = z.infer<
  typeof LearnedPreferenceRewardBindingSchema
>;
export type SftTrainingRecord = z.infer<typeof SftTrainingRecordSchema>;
export type DpoTrainingRecord = z.infer<typeof DpoTrainingRecordSchema>;
export type PolicyTrainingRecord = z.infer<typeof PolicyTrainingRecordSchema>;
export type TrainingRecipe = z.infer<typeof TrainingRecipeSchema>;
export type TrainingDestinationCapabilities = z.infer<
  typeof TrainingDestinationCapabilitiesSchema
>;
export type BaseModelExecutionOption = z.infer<
  typeof BaseModelExecutionOptionSchema
>;
export type BaseModelCandidate = z.infer<typeof BaseModelCandidateSchema>;
export type TrainingCompatibilityReport = z.infer<
  typeof TrainingCompatibilityReportSchema
>;
export type TrainingMethodAvailabilityReasonCode = z.infer<
  typeof TrainingMethodAvailabilityReasonCodeSchema
>;
export type TrainingMethodAvailability = z.infer<
  typeof TrainingMethodAvailabilitySchema
>;
export type ModelRunPreset = z.infer<typeof ModelRunPresetSchema>;
export type ModelProject = z.infer<typeof ModelProjectSchema>;
export type ModelProjectTrainingSetup = z.infer<
  typeof ModelProjectTrainingSetupSchema
>;
export type TrainingPlan = z.infer<typeof TrainingPlanSchema>;
export type TrainingBundleManifest = z.infer<
  typeof TrainingBundleManifestSchema
>;
export type TrainingBundleExport = z.infer<typeof TrainingBundleExportSchema>;
export type TrainingPreparedStart = z.infer<typeof TrainingPreparedStartSchema>;
export type TrainingApproval = z.infer<typeof TrainingApprovalSchema>;
export type TrainingJobSourceSnapshot = z.infer<
  typeof TrainingJobSourceSnapshotSchema
>;
export type TrainingJob = z.infer<typeof TrainingJobSchema>;
export type TrainingJobEvent = z.infer<typeof TrainingJobEventSchema>;
export type SftStepMetric = z.infer<typeof SftStepMetricSchema>;
export type PolicyOptimizationMetric = z.infer<
  typeof PolicyOptimizationMetricSchema
>;
export type ManagedTrainingRunEvidence = z.infer<
  typeof ManagedTrainingRunEvidenceSchema
>;
export type TrainingEvaluationAggregate = z.infer<
  typeof TrainingEvaluationAggregateSchema
>;
export type TrainingEvaluationGrade = z.infer<
  typeof TrainingEvaluationGradeSchema
>;
export type TrainingEvaluationExample = z.infer<
  typeof TrainingEvaluationExampleSchema
>;
export type TrainingEvaluationSummary = z.infer<
  typeof TrainingEvaluationSummarySchema
>;
export type TrainingRunDetail = z.infer<typeof TrainingRunDetailSchema>;
export type TrainingArtifact = z.infer<typeof TrainingArtifactSchema>;
export type ModelArtifactLineage = z.infer<typeof ModelArtifactLineageSchema>;
export type ModelBindingRole = z.infer<typeof ModelBindingRoleSchema>;
export type ModelBinding = z.infer<typeof ModelBindingSchema>;
export type TrainingStateResponse = z.infer<typeof TrainingStateResponseSchema>;
export type TrainingActivityResponse = z.infer<typeof TrainingActivityResponseSchema>;
export type TasksetOperationalState = z.infer<typeof TasksetOperationalStateSchema>;
