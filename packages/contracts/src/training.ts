import { z } from "zod";
import { BaselineReportSchema, GraderAuditReportSchema, TaskCreationSnapshotSchema, TasksetSchema, TrainingSourceRefSchema } from "./tasksets.js";
import { TaskCandidateSchema, TaskMinerConfigSchema, TaskMinerRunSchema } from "./task-mining.js";
import { CrossSystemFrontierBaselineRunSchema } from "./cross-system-frontier-baseline.js";

const IdSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().trim().min(1);
const HashSchema = z.string().trim().min(8).max(256);
const MetadataSchema = z.record(z.string(), z.unknown()).default({});

export const TrainingMethodSchema = z.enum(["sft", "dpo", "grpo", "sdft", "opd", "opsd", "sdpo"]);
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
  dataset: z.object({ trainSplit: z.literal("train"), validationSplit: z.enum(["validation", "frozen_eval"]), completionOnly: z.boolean(), maxSequenceLength: z.number().int().positive().max(32_768) }),
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

export const UnsupportedTrainingRecipeSchema = z.object({
  schemaVersion: z.literal("openpond.unsupportedRecipe.v1"),
  method: TrainingMethodSchema.exclude(["sft"]),
  parameterization: TrainingParameterizationSchema,
  unsupportedReason: z.string().trim().min(1).max(5_000),
});
export const TrainingRecipeSchema = z.union([SftRecipeSchema, UnsupportedTrainingRecipeSchema]);

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

export const TrainingPlanSchema = z.object({
  schemaVersion: z.literal("openpond.trainingPlan.v1"),
  id: IdSchema,
  tasksetId: IdSchema,
  tasksetHash: HashSchema,
  destinationId: TrainingDestinationIdSchema,
  recipe: TrainingRecipeSchema,
  environmentPlacement: z.enum(["none", "local", "remote", "colocated", "provider_native"]),
  compatibility: TrainingCompatibilityReportSchema,
  dataPolicy: z.object({ exportApproved: z.boolean(), approvedSourceIds: z.array(IdSchema), retentionDays: z.number().int().nonnegative().nullable(), region: z.string().trim().min(1).max(200).nullable() }),
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
  loss: z.number().nonnegative().nullable(),
  learningRate: z.number().nonnegative().nullable(),
  gradientNorm: z.number().nonnegative().nullable(),
  entropy: z.number().nonnegative().nullable(),
  meanTokenAccuracy: z.number().min(0).max(1).nullable(),
  inputTokensSeen: z.number().int().nonnegative().nullable(),
  memoryBytes: z.number().int().nonnegative().nullable(),
  elapsedSeconds: z.number().nonnegative().nullable(),
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

export const ModelArtifactLineageSchema = z.object({
  schemaVersion: z.literal("openpond.modelArtifactLineage.v1"),
  id: IdSchema,
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
  promotable: z.literal(false),
  status: z.enum(["imported", "rejected"]).default("imported"),
  rejectedAt: TimestampSchema.nullable().default(null),
  rejectionReason: z.string().trim().min(1).max(5_000).nullable().default(null),
  chatConfiguration: LocalModelChatConfigurationSchema.default(DEFAULT_LOCAL_MODEL_CHAT_CONFIGURATION),
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
  baselineReports: z.array(BaselineReportSchema),
  graderAuditReports: z.array(GraderAuditReportSchema),
  candidates: z.array(TaskCandidateSchema),
  minerConfig: TaskMinerConfigSchema,
  minerRuns: z.array(TaskMinerRunSchema).default([]),
  frontierBaselineRuns: z.array(CrossSystemFrontierBaselineRunSchema).default([]),
  plans: z.array(TrainingPlanSchema),
  bundles: z.array(TrainingBundleManifestSchema),
  jobs: z.array(TrainingJobSchema),
  artifacts: z.array(TrainingArtifactSchema),
  models: z.array(ModelArtifactLineageSchema),
  destinations: z.array(TrainingDestinationCapabilitiesSchema),
  credentialRefs: z.array(TrainingCredentialRefSchema),
  generatedAt: TimestampSchema,
});

export type TrainingMethod = z.infer<typeof TrainingMethodSchema>;
export type TrainingDestinationId = z.infer<typeof TrainingDestinationIdSchema>;
export type SftRecipe = z.infer<typeof SftRecipeSchema>;
export type SftTrainingRecord = z.infer<typeof SftTrainingRecordSchema>;
export type TrainingRecipe = z.infer<typeof TrainingRecipeSchema>;
export type TrainingDestinationCapabilities = z.infer<typeof TrainingDestinationCapabilitiesSchema>;
export type TrainingCompatibilityReport = z.infer<typeof TrainingCompatibilityReportSchema>;
export type TrainingPlan = z.infer<typeof TrainingPlanSchema>;
export type TrainingBundleManifest = z.infer<typeof TrainingBundleManifestSchema>;
export type TrainingBundleExport = z.infer<typeof TrainingBundleExportSchema>;
export type TrainingApproval = z.infer<typeof TrainingApprovalSchema>;
export type TrainingJob = z.infer<typeof TrainingJobSchema>;
export type TrainingJobEvent = z.infer<typeof TrainingJobEventSchema>;
export type SftStepMetric = z.infer<typeof SftStepMetricSchema>;
export type TrainingEvaluationAggregate = z.infer<typeof TrainingEvaluationAggregateSchema>;
export type TrainingEvaluationGrade = z.infer<typeof TrainingEvaluationGradeSchema>;
export type TrainingEvaluationExample = z.infer<typeof TrainingEvaluationExampleSchema>;
export type TrainingEvaluationSummary = z.infer<typeof TrainingEvaluationSummarySchema>;
export type TrainingRunDetail = z.infer<typeof TrainingRunDetailSchema>;
export type TrainingArtifact = z.infer<typeof TrainingArtifactSchema>;
export type LocalModelChatConfiguration = z.infer<typeof LocalModelChatConfigurationSchema>;
export type ModelArtifactLineage = z.infer<typeof ModelArtifactLineageSchema>;
export type TrainingStateResponse = z.infer<typeof TrainingStateResponseSchema>;
