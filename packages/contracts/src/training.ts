import { z } from "zod";
import {
  BaseModelPreferenceSchema,
  BaselineRftSignalSchema,
  BaselineReportSchema,
  BaselineScopeSchema,
  DatasetBuildIntentSchema,
  DatasetBuildSpecificationSchema,
  GraderAuditReportSchema,
  TasksetBaselineRunSchema,
  TaskCreationSnapshotSchema,
  TasksetSchema,
  TrainingMethodReadinessReasonCodeSchema,
  TrainingSourceRefSchema,
} from "./tasksets.js";
import { TaskCandidateSchema, TaskMinerConfigSchema, TaskMinerRunSchema } from "./task-mining.js";
import { CrossSystemFrontierBaselineRunSchema } from "./cross-system-frontier-baseline.js";
import {
  CrossSystemTrajectorySchema,
  CrossSystemVerifierResultSchema,
} from "./cross-system-operations.js";
import { DatasetArtifactSummarySchema } from "./dataset-artifacts.js";
import { DatasetImportJobSchema } from "./dataset-imports.js";
import {
  PolicyOptimizationBudgetSchema,
  PolicyOptimizationContractSchema,
  PolicyOptimizerSchema,
  PpoOptimizerSchema,
  RftLossMethodSchema,
  TrainingModelRefSchema,
} from "./training-policy-optimization.js";
export {
  GrpoOptimizerSchema,
  PolicyOptimizationBudgetSchema,
  PolicyOptimizationContractSchema,
  PolicyOptimizerSchema,
  PpoOptimizerSchema,
  RftLossMethodSchema,
  TrainingModelRefSchema,
} from "./training-policy-optimization.js";

const IdSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().trim().min(1);
const HashSchema = z.string().trim().min(8).max(256);
const MetadataSchema = z.record(z.string(), z.unknown()).default({});

export const DATASET_EXACT_ANSWER_ENVIRONMENT_ID =
  "dataset-exact-answer" as const;
export const DATASET_EXACT_ANSWER_ENVIRONMENT_VERSION =
  "dataset-exact-answer-v1" as const;
export const DATASET_NO_TOOLS_CONTRACT_HASH = "no-tools-v1" as const;
export const TrainingMethodSchema = z.enum(["sft", "dpo", "grpo", "ppo", "sdft", "opd", "opsd", "sdpo"]);
export const TrainingParameterizationSchema = z.enum(["lora", "full"]);
export const TrainingDestinationIdSchema = z.enum([
  "export",
  "local_cpu_fixture",
  "openpond_managed",
  "custom",
  "prime_hosted",
  "fireworks",
  "local_cuda",
  "local_mlx",
  "ssh_gpu",
  "runpod_byoc",
]);

export const SftRecipeSchema = z.object({
  schemaVersion: z.literal("openpond.sftRecipe.v1"),
  method: z.literal("sft"),
  parameterization: z.literal("lora"),
  baseModel: z.object({ id: IdSchema, revision: z.string().trim().min(1).max(256), tokenizerRevision: z.string().trim().min(1).max(256), chatTemplateHash: HashSchema }),
  dataset: z.object({
    trainSplit: z.literal("train"),
    validationSplit: z.enum(["validation", "frozen_eval"]),
    completionOnly: z.boolean(),
    maxSequenceLength: z.number().int().positive().max(32_768),
    maxExamples: z.number().int().positive().max(100_000).default(1_000),
    selectionStrategy: z.literal("stable_hash_top_n").default("stable_hash_top_n"),
    selectionSeed: z.number().int().default(17),
  }),
  lora: z.object({ rank: z.number().int().positive().max(256), alpha: z.number().positive().max(1_024), dropout: z.number().min(0).max(1), targetModules: z.array(IdSchema).min(1).max(100) }),
  optimizer: z.object({ learningRate: z.number().positive(), epochs: z.number().positive().max(100), maxSteps: z.number().int().positive().max(1_000_000), batchSize: z.number().int().positive().max(10_000), gradientAccumulationSteps: z.number().int().positive().max(10_000), seed: z.number().int() }),
  resourceLimits: z.object({ cpuThreads: z.number().int().positive().max(256), memoryBytes: z.number().int().positive(), wallTimeMs: z.number().int().positive() }),
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
    selectionStrategy: z.enum([
      "stable_hash_top_n",
      "rft_easy_curriculum_v1",
    ]).default("stable_hash_top_n"),
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
  }),
  loss: z.object({
    method: RftLossMethodSchema.default("grpo"),
    klBeta: z.number().min(0).nullable().default(null),
  }).default({ method: "grpo", klBeta: null }),
  reward: z.object({
    graderId: IdSchema,
    graderHash: HashSchema,
    environmentId: IdSchema,
    environmentVersion: z.string().trim().min(1).max(256),
    toolContractHash: HashSchema,
  }),
  resourceLimits: z.object({
    wallTimeMs: z.number().int().positive().max(24 * 60 * 60 * 1_000),
    maxRollouts: z.number().int().positive().max(100_000),
    maxPayloadBytes: z.number().int().positive().max(10 * 1024 * 1024),
  }),
  policyOptimization: PolicyOptimizationContractSchema.nullable().default(null),
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
  environmentPlacements: z.array(z.enum(["none", "local", "remote", "colocated", "provider_native"])),
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

export const PolicyOptimizationComparisonSchema = z.object({
  schemaVersion: z.literal("openpond.policyOptimizationComparison.v1"),
  grpoPlanId: IdSchema,
  ppoPlanId: IdSchema,
  comparable: z.boolean(),
  shared: z.object({
    tasksetId: IdSchema,
    tasksetHash: HashSchema,
    policyModelHash: HashSchema,
    referenceModelHash: HashSchema,
    environmentHash: HashSchema,
    rewardHash: HashSchema,
    rolloutBudgetHash: HashSchema,
    evaluationSplit: z.literal("frozen_eval"),
  }).nullable(),
  mismatches: z.array(z.enum([
    "dataset",
    "policy_model",
    "reference_model",
    "environment",
    "reward",
    "rollout_budget",
    "evaluation",
  ])),
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

export const ModelBuildRunPresetSchema = z.enum([
  "small",
  "standard",
  "custom",
  "small_experiment",
]);

export const ModelBuildDraftSchema = z.object({
  schemaVersion: z.literal("openpond.modelBuildDraft.v1"),
  id: IdSchema,
  profileId: IdSchema,
  modelId: IdSchema,
  name: z.string().trim().min(1).max(200),
  objective: z.string().trim().max(5_000).nullable(),
  status: z.enum(["draft", "ready_to_run", "launched", "cancelled"]),
  datasetMode: z.enum(["existing", "build"]).nullable(),
  tasksetRef: z.object({
    id: IdSchema,
    revision: z.number().int().positive(),
    contentHash: HashSchema,
  }).nullable(),
  datasetCreationId: IdSchema.nullable(),
  buildIntent: DatasetBuildIntentSchema.nullable(),
  buildSpecification: DatasetBuildSpecificationSchema.nullable(),
  baseModel: BaseModelPreferenceSchema.nullable(),
  method: TrainingMethodSchema.nullable(),
  destinationId: TrainingDestinationIdSchema.nullable(),
  runPreset: ModelBuildRunPresetSchema.nullable(),
  recipe: TrainingRecipeSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const TrainingPlanSchema = z.object({
  schemaVersion: z.literal("openpond.trainingPlan.v1"),
  id: IdSchema,
  modelId: IdSchema,
  tasksetId: IdSchema,
  tasksetHash: HashSchema,
  destinationId: TrainingDestinationIdSchema,
  recipe: TrainingRecipeSchema,
  environmentPlacement: z.enum(["none", "local", "remote", "colocated", "provider_native"]),
  compatibility: TrainingCompatibilityReportSchema,
  dataPolicy: z.object({ exportApproved: z.boolean(), approvedSourceIds: z.array(IdSchema), retentionDays: z.number().int().nonnegative().nullable(), region: z.string().trim().min(1).max(200).nullable() }),
  rftSignalGate: z.object({
    baselineReportId: IdSchema,
    baselineReportHash: HashSchema,
    scope: BaselineScopeSchema,
    signal: BaselineRftSignalSchema,
  }).nullable().default(null),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  createdAt: TimestampSchema,
  contentHash: HashSchema,
});

export const TrainingBundleFileSchema = z.object({
  path: z.string().trim().min(1).max(2_000),
  sha256: HashSchema,
  sizeBytes: z.number().int().nonnegative(),
  role: z.enum(["manifest", "task_data", "grader", "environment", "recipe", "policy", "provenance"]),
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
  files: z.array(z.object({ path: z.string().trim().min(1).max(2_000), sha256: HashSchema, sizeBytes: z.number().int().nonnegative(), encoding: z.literal("base64"), content: z.string() })).min(1),
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
  destinationId: TrainingDestinationIdSchema,
  modelId: IdSchema,
  method: TrainingMethodSchema,
  parameterization: TrainingParameterizationSchema,
  maximumCostUsd: z.number().nonnegative().nullable(),
  approvedBy: IdSchema,
  approvedAt: TimestampSchema,
});

export const TrainingJobStatusSchema = z.enum(["queued", "starting", "running", "cancelling", "cancelled", "succeeded", "failed", "reconciling"]);
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
  type: z.enum(["queued", "start", "progress", "metric", "checkpoint", "cancel", "complete", "failure", "reconcile"]),
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
  policyLoss: z.number().nullable(),
  valueLoss: z.number().nullable(),
  meanReward: z.number().nullable(),
  meanReturn: z.number().nullable(),
  kl: z.number().nullable(),
  entropy: z.number().nullable(),
  policyClipFraction: z.number().min(0).max(1).nullable(),
  valueClipFraction: z.number().min(0).max(1).nullable(),
  explainedVariance: z.number().nullable(),
  rolloutLearnerLag: z.number().int().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  environmentExecutions: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
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
  failureClass: z.enum(["policy_failure", "grader_failure", "environment_failure", "infrastructure_failure", "timeout", "cancelled"]).nullable(),
  feedback: z.array(z.string().trim().min(1).max(20_000)).max(1_000),
  components: z.array(z.object({
    graderId: IdSchema,
    score: z.number().min(0).max(1),
    passed: z.boolean(),
    feedback: z.string().trim().max(20_000).nullable(),
  })).max(1_000),
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
  evaluation: TrainingEvaluationSummarySchema.nullable(),
  generatedAt: TimestampSchema,
});

export const TrainingArtifactSchema = z.object({
  schemaVersion: z.literal("openpond.trainingArtifact.v1"),
  id: IdSchema,
  jobId: IdSchema,
  kind: z.enum(["adapter", "checkpoint", "metrics", "log", "manifest", "evaluation"]),
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

export const LocalModelChatConfigurationSchema = z.object({
  schemaVersion: z.literal("openpond.localModelChatConfiguration.v1").default("openpond.localModelChatConfiguration.v1"),
  profile: z.enum(["efficient", "full_harness", "custom"]).default("efficient"),
  systemPromptMode: z.enum(["lean", "full_harness", "custom"]).default("lean"),
  customSystemPrompt: z.string().max(20_000).nullable().default(null),
  contextWindowTokens: z.number().int().min(128).max(32_768).default(1_024),
  maxOutputTokens: z.number().int().min(1).max(512).default(64),
  temperature: z.number().min(0).max(2).default(0),
  repetitionPenalty: z.number().min(0.5).max(2).default(1.1),
  noRepeatNgramSize: z.number().int().min(0).max(10).default(3),
  compaction: z.enum(["off", "when_needed"]).default("when_needed"),
  keepWarmSeconds: z.number().int().min(0).max(3_600).default(300),
  updatedAt: TimestampSchema.nullable().default(null),
});

export const DEFAULT_LOCAL_MODEL_CHAT_CONFIGURATION = LocalModelChatConfigurationSchema.parse({});

export const ManagedAdapterServingProjectionSchema = z.object({
  schemaVersion: z.literal("openpond.managedAdapterServingProjection.v1"),
  teamId: IdSchema.nullable().default(null),
  source: z.literal("openpond_fireworks"),
  sourceRef: IdSchema,
  canonicalArtifactId: IdSchema.nullable(),
  canonicalArtifactState: z.enum([
    "imported_unvalidated",
    "evaluating",
    "promotable",
    "rejected",
    "deleted",
  ]).nullable(),
  canonicalDeploymentId: IdSchema.nullable(),
  canonicalDeploymentState: z.enum([
    "requested",
    "provisioning",
    "ready",
    "degraded",
    "deleting",
    "deleted",
    "failed",
  ]).nullable(),
  state: z.enum(["pending", "imported", "ready", "failed"]),
  publishedAt: TimestampSchema.nullable(),
  lastSyncedAt: TimestampSchema,
  lastError: z.string().trim().min(1).max(5_000).nullable(),
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
  chatConfiguration: LocalModelChatConfigurationSchema.default(DEFAULT_LOCAL_MODEL_CHAT_CONFIGURATION),
  managedServing: ManagedAdapterServingProjectionSchema.nullable().default(null),
});

export const SingleTurnPolicyTrajectorySchema = z.object({
  schemaVersion: z.literal("openpond.singleTurnPolicyTrajectory.v1"),
  id: IdSchema,
  taskId: IdSchema,
  status: z.enum(["completed", "infrastructure_failure"]),
  promptHash: HashSchema,
  responseText: z.string().max(2_000_000),
  infrastructureError: z.string().trim().min(1).max(10_000).nullable(),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  metadata: MetadataSchema,
});

export const PpoTrajectorySchema = z.object({
  schemaVersion: z.literal("openpond.ppoTrajectory.v1"),
  id: IdSchema,
  taskId: IdSchema,
  policyModelId: IdSchema,
  referenceModelId: IdSchema,
  valueModelId: IdSchema,
  steps: z.array(z.object({
    index: z.number().int().nonnegative(),
    observationHash: HashSchema,
    actionTokenIds: z.array(z.number().int().nonnegative()).min(1),
    terminated: z.boolean(),
    truncated: z.boolean(),
    reward: z.number(),
    policyLogProbability: z.number(),
    referenceLogProbability: z.number(),
    valuePrediction: z.number(),
    return: z.number(),
    advantage: z.number(),
    mask: z.number().min(0).max(1),
  })).min(1).max(100_000),
  createdAt: TimestampSchema,
});

export const ExactAnswerVerifierResultSchema = z.object({
  schemaVersion: z.literal("openpond.exactAnswerVerifierResult.v1"),
  outcome: z.enum([
    "correct",
    "incorrect",
    "parse_failure",
    "infrastructure_failure",
  ]),
  graderSetHash: HashSchema,
  score: z.number().min(0).max(1).nullable(),
  passed: z.boolean(),
  rewardEligible: z.boolean(),
  expectedAnswerHash: HashSchema,
  extractedAnswer: z.string().max(20_000).nullable(),
  feedback: z.array(z.string().trim().min(1).max(20_000)).max(1_000),
});

export const RolloutTrajectoryReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.rolloutTrajectoryReceipt.v1"),
  id: IdSchema,
  jobId: IdSchema,
  planId: IdSchema,
  tasksetId: IdSchema,
  tasksetHash: HashSchema,
  taskId: IdSchema,
  split: z.literal("train"),
  correlationId: IdSchema,
  provider: IdSchema,
  providerTrace: z.object({
    invocationId: IdSchema,
    experimentId: IdSchema,
    rolloutId: IdSchema,
    runId: IdSchema,
    rowId: IdSchema,
  }),
  optimizerMethod: z.enum(["grpo", "ppo"]).default("grpo"),
  evidenceLevels: z.object({
    requested: z.enum(["trajectory", "aggregate", "provider_reported"]),
    observed: z.enum(["trajectory", "aggregate", "provider_reported"]),
    providerReported: z.enum(["trajectory", "aggregate", "provider_reported"]),
  }).default({
    requested: "trajectory",
    observed: "trajectory",
    providerReported: "provider_reported",
  }),
  budgetUsage: z.object({
    rollouts: z.number().int().nonnegative(),
    environmentExecutions: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    optimizerSteps: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }).default({
    rollouts: 0,
    environmentExecutions: 0,
    inputTokens: 0,
    outputTokens: 0,
    optimizerSteps: 0,
    costUsd: 0,
  }),
  environment: z.object({
    id: IdSchema,
    version: z.string().trim().min(1).max(256),
    worldId: IdSchema,
    worldHash: HashSchema,
    toolContractHash: HashSchema,
  }),
  policy: z.object({
    modelId: IdSchema,
    checkpointId: IdSchema.nullable(),
    completionParametersHash: HashSchema,
  }),
  status: z.enum(["received", "running", "succeeded", "failed"]),
  failureClass: z.enum([
    "policy_failure",
    "parse_failure",
    "tool_schema_violation",
    "budget_exhausted",
    "cancelled",
    "environment_failure",
    "infrastructure_failure",
  ]).nullable(),
  reward: z.object({
    eligible: z.boolean(),
    raw: z.number().min(0).max(1.15).nullable(),
    normalized: z.number().min(0).max(1).nullable(),
    components: z.record(z.string(), z.number()),
  }),
  trajectory: z.union([
    CrossSystemTrajectorySchema,
    SingleTurnPolicyTrajectorySchema,
    PpoTrajectorySchema,
  ]).nullable(),
  verifier: z.union([
    CrossSystemVerifierResultSchema,
    ExactAnswerVerifierResultSchema,
  ]).nullable(),
  providerStatus: z.record(z.string(), z.unknown()).default({}),
  receivedAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
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
  evaluationArtifactId: IdSchema,
  status: z.enum(["active", "rolled_back"]),
  priorBindingId: IdSchema.nullable(),
  rollbackTargetBindingId: IdSchema.nullable(),
  promotedBy: IdSchema,
  promotedAt: TimestampSchema,
  rolledBackAt: TimestampSchema.nullable(),
  metadata: MetadataSchema,
});

export const FireworksModelServingSessionSchema = z.object({
  schemaVersion: z.literal("openpond.fireworksModelServingSession.v1"),
  id: IdSchema,
  runtimeId: IdSchema,
  profileId: IdSchema,
  modelArtifactLineageId: IdSchema,
  jobId: IdSchema,
  tasksetId: IdSchema,
  provider: z.literal("fireworks"),
  state: z.enum([
    "starting",
    "ready",
    "stopping",
    "stopped",
    "failed",
  ]),
  accountId: IdSchema.nullable(),
  baseModel: IdSchema,
  outputModel: IdSchema,
  deploymentId: IdSchema,
  deployedModelId: IdSchema.nullable(),
  acceleratorType: z.literal("NVIDIA_H100_80GB"),
  acceleratorCount: z.literal(1),
  hourlyCostUsd: z.number().positive(),
  idleTimeoutSeconds: z.number().int().min(60).max(3_600),
  maxDurationSeconds: z.number().int().min(60).max(3_600),
  maxEstimatedCostUsd: z.number().positive(),
  estimatedCostUsd: z.number().nonnegative(),
  createdAt: TimestampSchema,
  readyAt: TimestampSchema.nullable(),
  lastUsedAt: TimestampSchema.nullable(),
  stopRequestedAt: TimestampSchema.nullable(),
  stoppedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
  stopReason: z.enum([
    "user",
    "idle",
    "duration",
    "budget",
    "restart_cleanup",
    "startup_error",
    "shutdown",
  ]).nullable(),
  error: z.string().trim().min(1).max(5_000).nullable(),
});

export const ManagedTrainingClientConfigSchema = z.object({
  schemaVersion: z.literal("openpond.managedTrainingClient.v1"),
  endpoint: z.string().url(),
  accountId: IdSchema.nullable(),
  enabled: z.boolean().default(false),
});

export const TrainingCredentialRefSchema = z.object({
  destinationId: z.string().trim().min(1),
  configured: z.boolean(),
  createdAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema.nullable(),
});

export const TrainingStateResponseSchema = z.object({
  schemaVersion: z.literal("openpond.trainingState.v1"),
  profileId: IdSchema,
  sources: z.array(TrainingSourceRefSchema),
  creations: z.array(TaskCreationSnapshotSchema),
  tasksets: z.array(TasksetSchema),
  datasetImports: z.array(DatasetImportJobSchema).default([]),
  datasetArtifacts: z.array(DatasetArtifactSummarySchema).default([]),
  baselineReports: z.array(BaselineReportSchema),
  baselineRuns: z.array(TasksetBaselineRunSchema).default([]),
  graderAuditReports: z.array(GraderAuditReportSchema),
  candidates: z.array(TaskCandidateSchema),
  minerConfig: TaskMinerConfigSchema,
  minerRuns: z.array(TaskMinerRunSchema).default([]),
  frontierBaselineRuns: z.array(CrossSystemFrontierBaselineRunSchema).default([]),
  modelBuildDrafts: z.array(ModelBuildDraftSchema).default([]),
  plans: z.array(TrainingPlanSchema),
  bundles: z.array(TrainingBundleManifestSchema),
  jobs: z.array(TrainingJobSchema),
  artifacts: z.array(TrainingArtifactSchema),
  models: z.array(ModelArtifactLineageSchema),
  rolloutReceipts: z.array(RolloutTrajectoryReceiptSchema).default([]),
  modelBindings: z.array(ModelBindingSchema).default([]),
  servingSessions: z.array(FireworksModelServingSessionSchema).default([]),
  destinations: z.array(TrainingDestinationCapabilitiesSchema),
  baseModelCandidates: z.array(BaseModelCandidateSchema).default([]),
  credentialRefs: z.array(TrainingCredentialRefSchema),
  generatedAt: TimestampSchema,
});

export type TrainingMethod = z.infer<typeof TrainingMethodSchema>;
export type TrainingDestinationId = z.infer<typeof TrainingDestinationIdSchema>;
export type RftLossMethod = z.infer<typeof RftLossMethodSchema>;
export type PolicyOptimizationBudget = z.infer<typeof PolicyOptimizationBudgetSchema>;
export type PolicyOptimizer = z.infer<typeof PolicyOptimizerSchema>;
export type PolicyOptimizationContract = z.infer<typeof PolicyOptimizationContractSchema>;
export type SftRecipe = z.infer<typeof SftRecipeSchema>;
export type DpoRecipe = z.infer<typeof DpoRecipeSchema>;
export type PpoRecipe = z.infer<typeof PpoRecipeSchema>;
export type RftRecipe = z.infer<typeof RftRecipeSchema>;
export type SftTrainingRecord = z.infer<typeof SftTrainingRecordSchema>;
export type DpoTrainingRecord = z.infer<typeof DpoTrainingRecordSchema>;
export type PolicyTrainingRecord = z.infer<typeof PolicyTrainingRecordSchema>;
export type TrainingRecipe = z.infer<typeof TrainingRecipeSchema>;
export type TrainingDestinationCapabilities = z.infer<typeof TrainingDestinationCapabilitiesSchema>;
export type BaseModelExecutionOption = z.infer<typeof BaseModelExecutionOptionSchema>;
export type BaseModelCandidate = z.infer<typeof BaseModelCandidateSchema>;
export type TrainingCompatibilityReport = z.infer<typeof TrainingCompatibilityReportSchema>;
export type PolicyOptimizationComparison = z.infer<typeof PolicyOptimizationComparisonSchema>;
export type TrainingMethodAvailabilityReasonCode = z.infer<typeof TrainingMethodAvailabilityReasonCodeSchema>;
export type TrainingMethodAvailability = z.infer<typeof TrainingMethodAvailabilitySchema>;
export type ModelBuildRunPreset = z.infer<typeof ModelBuildRunPresetSchema>;
export type ModelBuildDraft = z.infer<typeof ModelBuildDraftSchema>;
export type TrainingPlan = z.infer<typeof TrainingPlanSchema>;
export type TrainingBundleManifest = z.infer<typeof TrainingBundleManifestSchema>;
export type TrainingBundleExport = z.infer<typeof TrainingBundleExportSchema>;
export type TrainingPreparedStart = z.infer<typeof TrainingPreparedStartSchema>;
export type TrainingApproval = z.infer<typeof TrainingApprovalSchema>;
export type TrainingJob = z.infer<typeof TrainingJobSchema>;
export type TrainingJobEvent = z.infer<typeof TrainingJobEventSchema>;
export type SftStepMetric = z.infer<typeof SftStepMetricSchema>;
export type PolicyOptimizationMetric = z.infer<typeof PolicyOptimizationMetricSchema>;
export type TrainingEvaluationAggregate = z.infer<typeof TrainingEvaluationAggregateSchema>;
export type TrainingEvaluationGrade = z.infer<typeof TrainingEvaluationGradeSchema>;
export type TrainingEvaluationExample = z.infer<typeof TrainingEvaluationExampleSchema>;
export type TrainingEvaluationSummary = z.infer<typeof TrainingEvaluationSummarySchema>;
export type TrainingRunDetail = z.infer<typeof TrainingRunDetailSchema>;
export type TrainingArtifact = z.infer<typeof TrainingArtifactSchema>;
export type LocalModelChatConfiguration = z.infer<typeof LocalModelChatConfigurationSchema>;
export type ModelArtifactLineage = z.infer<typeof ModelArtifactLineageSchema>;
export type ManagedAdapterServingProjection = z.infer<
  typeof ManagedAdapterServingProjectionSchema
>;
export type RolloutTrajectoryReceipt = z.infer<typeof RolloutTrajectoryReceiptSchema>;
export type PpoTrajectory = z.infer<typeof PpoTrajectorySchema>;
export type ModelBindingRole = z.infer<typeof ModelBindingRoleSchema>;
export type ModelBinding = z.infer<typeof ModelBindingSchema>;
export type FireworksModelServingSession = z.infer<
  typeof FireworksModelServingSessionSchema
>;
export type TrainingStateResponse = z.infer<typeof TrainingStateResponseSchema>;
