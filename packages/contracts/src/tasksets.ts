import { z } from "zod";
import { ChatModelRefSchema } from "./providers.js";
import { CodexReasoningEffortSchema } from "./settings.js";
import { TrainingTacticSchema } from "./task-mining.js";
import { DatasetArtifactManifestSchema, DatasetSplitSchema } from "./dataset-artifacts.js";
import { ExternalDatasetSourceRefSchema } from "./dataset-sources.js";
import { HarnessActionBindingSchema } from "./harness-actions.js";
import { VersionedReleaseRefSchema } from "./release-core.js";

const IdSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().trim().min(1);
const HashSchema = z.string().trim().min(8).max(256);
const Sha256Schema = z.string().trim().regex(/^[a-f0-9]{64}$/);
const CodeIdentifierSchema = z.string().trim().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
const MetadataSchema = z.record(z.string(), z.unknown()).default({});
const NullableIdSchema = IdSchema.nullable();

function safeRelativeFilePath(value: string): boolean {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized === "."
    || normalized === ".."
  ) {
    return false;
  }
  return !normalized.split("/").some((segment) =>
    !segment || segment === "." || segment === ".."
  );
}

function safeFileName(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length > 0
    && normalized !== "."
    && normalized !== ".."
    && !normalized.includes("/")
    && !normalized.includes("\\")
    && !normalized.includes("\0")
  );
}

export const TasksetSplitSchema = DatasetSplitSchema;
export const TASKSET_WORK_TOOL_NAMES = [
  "work_capabilities",
  "work_environment",
  "work_list_files",
  "work_read_file",
  "work_read_document",
  "work_write_file",
  "work_write_docx",
  "work_edit_file",
  "work_delete_file",
  "work_exec",
  "work_save_output",
  "work_stop",
] as const;
export const TasksetStatusSchema = z.enum([
  "draft",
  "awaiting_disclosure_approval",
  "awaiting_materialization_approval",
  "materializing",
  "validating",
  "needs_review",
  "baselining",
  "ready",
  "blocked",
  "failed",
  "archived",
]);
export const TasksetPurposeSchema = z.enum(["general", "benchmark"]);
export const TasksetBenchmarkBindingSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetBenchmark.v1"),
  definitionId: IdSchema,
  releaseId: IdSchema,
  releaseHash: Sha256Schema,
  managedReleasePath: z.string().trim().min(1).max(1_000)
    .refine(safeRelativeFilePath, "Benchmark release paths must remain relative."),
  adaptationSplit: TasksetSplitSchema,
  evaluationSplit: TasksetSplitSchema,
  primaryMetric: z.enum([
    "foreground_tokens",
    "success_rate",
    "latency_ms",
    "cost_usd",
  ]),
  qualityGate: z.enum(["none", "non_regression", "all_pass"]),
  source: z.enum(["builtin", "imported"]),
  metadata: MetadataSchema,
});
/**
 * Product-level pointer to the portable comparison policy. The policy itself
 * remains in @openpond/evals; product Tasksets retain only its immutable ref.
 */
export const TasksetPreferenceComparisonBindingSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetPreferenceComparisonBinding.v1"),
  releaseId: IdSchema,
  releaseHash: Sha256Schema,
  publishedAt: TimestampSchema,
  metadata: MetadataSchema,
});
export const TaskCreationSurfaceSchema = z.enum([
  "slash_train",
  "session_menu",
  "bulk_selection",
  "training_page",
  "task_candidate",
]);
export const TaskCreationModeSchema = z.enum(["defaults", "customize"]);
export const NewModelModeSchema = z.enum(["automated", "manual"]);
export const DatasetBuildIntentSchema = z.enum([
  "demonstrations",
  "preferences",
  "verifiable_reward",
  "rubric",
  "discovery",
]);

const DatasetEvidenceTextSchema = z.string().trim().max(100_000);

export const DatasetBuildSpecificationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("demonstrations"),
    behavior: DatasetEvidenceTextSchema,
    examples: z.array(z.object({
      id: IdSchema,
      prompt: DatasetEvidenceTextSchema,
      response: DatasetEvidenceTextSchema,
    })).max(1_000).default([]),
  }),
  z.object({
    kind: z.literal("preferences"),
    preference: DatasetEvidenceTextSchema,
    pairs: z.array(z.object({
      id: IdSchema,
      prompt: DatasetEvidenceTextSchema,
      chosen: DatasetEvidenceTextSchema,
      rejected: DatasetEvidenceTextSchema,
      rationale: DatasetEvidenceTextSchema,
    })).max(1_000).default([]),
  }),
  z.object({
    kind: z.literal("verifiable_reward"),
    task: DatasetEvidenceTextSchema,
    rules: z.array(z.object({
      id: IdSchema,
      points: z.number().finite(),
      condition: DatasetEvidenceTextSchema,
    })).max(1_000).default([]),
    otherwisePoints: z.number().finite().default(0),
  }),
  z.object({
    kind: z.literal("rubric"),
    task: DatasetEvidenceTextSchema,
    criteria: z.array(z.object({
      id: IdSchema,
      label: z.string().trim().max(500),
      description: DatasetEvidenceTextSchema,
    })).max(1_000).default([]),
    positiveExample: DatasetEvidenceTextSchema,
    negativeExample: DatasetEvidenceTextSchema,
    boundaryExample: DatasetEvidenceTextSchema,
  }),
]);

export const TrainingSourceConsentSchema = z.object({
  status: z.enum(["pending", "granted", "denied", "revoked"]),
  scope: z.enum(["metadata_only", "selected_turns", "full_session"]),
  grantedBy: NullableIdSchema,
  grantedAt: TimestampSchema.nullable(),
  purpose: z.literal("task_authoring_and_evaluation"),
});

export const TrainingSourceRefSchema = z.object({
  schemaVersion: z.literal("openpond.trainingSource.v1"),
  id: IdSchema,
  profileId: IdSchema,
  sessionId: IdSchema,
  turnIds: z.array(IdSchema).max(1_000).default([]),
  workspaceId: NullableIdSchema,
  sourceHash: HashSchema,
  clusterKey: IdSchema,
  title: z.string().trim().min(1).max(500),
  occurredAt: TimestampSchema,
  consent: TrainingSourceConsentSchema,
  connectedAppIds: z.array(IdSchema).max(100).default([]),
  secretScanStatus: z.enum(["pending", "passed", "blocked"]),
  piiScanStatus: z.enum(["pending", "passed", "review", "blocked"]),
  licensingStatus: z.enum(["pending", "approved", "review", "blocked"]),
  metadata: MetadataSchema,
});

export const TasksetSourceRefSchema = z.union([
  TrainingSourceRefSchema,
  ExternalDatasetSourceRefSchema,
]);

export const TrainingSourceEstimateSchema = z.object({
  schemaVersion: z.literal("openpond.trainingSourceEstimate.v1"),
  sessionId: IdSchema,
  messageCount: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  textBytes: z.number().int().nonnegative(),
});

export const TrainingChatSearchRequestSchema = z.object({
  query: z.string().max(500).default(""),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(20),
  candidates: z.array(z.object({
    sessionId: IdSchema,
    title: z.string().trim().min(1).max(500),
    updatedAt: TimestampSchema,
  })).max(500).default([]),
});

export const TrainingChatSearchEntrySchema = z.object({
  sessionId: IdSchema,
  title: z.string().trim().min(1).max(500),
  updatedAt: TimestampSchema,
  snippet: z.string().max(2_000).nullable(),
});

export const TrainingChatSearchResultSchema = z.object({
  schemaVersion: z.literal("openpond.trainingChatSearchResult.v1"),
  query: z.string(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  indexedChats: z.number().int().nonnegative(),
  totalChats: z.number().int().nonnegative(),
  indexing: z.boolean(),
  entries: z.array(TrainingChatSearchEntrySchema),
});

export const TaskPolicyBoundarySchema = z.object({
  policyVisibleFields: z.array(IdSchema).max(1_000).default([]),
  privilegedFields: z.array(IdSchema).max(1_000).default([]),
  hiddenGraderRefs: z.array(IdSchema).max(100).default([]),
  connectedAppScopes: z.array(IdSchema).max(100).default([]),
});

export const TaskAssetRefSchema = z.object({
  id: IdSchema,
  sourceRefId: IdSchema,
  artifactRef: z.string().trim().min(1).max(4_000)
    .refine(safeRelativeFilePath, "Task asset references must be safe relative paths."),
  fileName: z.string().trim().min(1).max(500)
    .refine(safeFileName, "Task asset file names must not contain path separators."),
  mediaType: z.string().trim().min(1).max(200),
  sha256: Sha256Schema,
  sizeBytes: z.number().int().nonnegative().max(250_000_000),
  split: TasksetSplitSchema,
  metadata: MetadataSchema,
});

export const TaskRequiredOutputSchema = z.object({
  path: z.string().trim().min(1).max(1_000)
    .refine(safeRelativeFilePath, "Required output paths must stay inside the Work output directory."),
  mediaType: z.string().trim().min(1).max(200),
  schemaRef: IdSchema.nullable().optional(),
  maxBytes: z.number().int().positive().max(10_000_000).optional(),
  metadata: MetadataSchema,
});

export const TaskDataRecordSchema = z.object({
  schemaVersion: z.literal("openpond.taskData.v1"),
  id: IdSchema,
  clusterKey: IdSchema,
  split: TasksetSplitSchema,
  input: z.record(z.string(), z.unknown()),
  expectedOutput: z.record(z.string(), z.unknown()).nullable(),
  policyVisibleContext: z.record(z.string(), z.unknown()).default({}),
  privilegedContextRef: NullableIdSchema,
  sourceRefs: z.array(IdSchema).min(1).max(100),
  assets: z.array(TaskAssetRefSchema).max(1_000).optional(),
  resourceRefs: z.array(IdSchema).max(1_000).optional(),
  requiredOutputs: z.array(TaskRequiredOutputSchema).max(100).optional(),
  tags: z.array(IdSchema).max(100).default([]),
  metadata: MetadataSchema,
});

export const TasksetEnvironmentResourceSchema = z.object({
  id: IdSchema,
  kind: z.enum(["file", "catalog", "configuration", "code_module"]),
  path: z.string().trim().min(1).max(1_000)
    .refine(safeRelativeFilePath, "Environment resource paths must remain relative."),
  mediaType: z.string().trim().min(1).max(200).nullable().optional(),
  visibility: z.enum(["policy_visible", "policy_hidden", "privileged"]),
  required: z.boolean(),
  metadata: MetadataSchema,
});

const LearningSignalBaseSchema = z.object({
  id: IdSchema,
  taskId: NullableIdSchema,
  sourceRefs: z.array(IdSchema).min(1).max(100),
  artifactRef: IdSchema,
  approved: z.boolean(),
  confidence: z.number().min(0).max(1),
  metadata: MetadataSchema,
});

export const DemonstrationSignalSchema = LearningSignalBaseSchema.extend({
  kind: z.literal("demonstration"),
  prompt: z.string().max(100_000).nullable().default(null),
  response: z.string().max(200_000).nullable().default(null),
});
export const PreferenceSignalSchema = LearningSignalBaseSchema.extend({
  kind: z.literal("preference"),
  prompt: z.string().max(100_000),
  chosen: z.string().max(200_000),
  rejected: z.string().max(200_000),
  rationale: z.string().max(100_000).nullable().default(null),
});
export const CorrectionSignalSchema = LearningSignalBaseSchema.extend({
  kind: z.literal("correction"),
  original: z.string().max(200_000),
  corrected: z.string().max(200_000),
  rationale: z.string().max(100_000).nullable().default(null),
});
export const FeedbackSignalSchema = LearningSignalBaseSchema.extend({
  kind: z.literal("feedback"),
  feedback: z.string().max(100_000),
  polarity: z.enum(["positive", "negative", "mixed", "neutral"]),
});
export const RewardSignalSchema = LearningSignalBaseSchema.extend({
  kind: z.literal("reward"),
  task: z.string().max(100_000),
  rules: z.array(z.object({
    id: IdSchema,
    points: z.number().finite(),
    condition: z.string().trim().min(1).max(100_000),
  })).min(1).max(1_000),
  otherwisePoints: z.number().finite(),
  executable: z.boolean(),
});
export const LabelSignalSchema = LearningSignalBaseSchema.extend({
  kind: z.literal("label"),
  labelKind: z.literal("rubric"),
  task: z.string().max(100_000),
  criteria: z.array(z.object({
    id: IdSchema,
    label: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(100_000),
  })).min(1).max(1_000),
  calibrationExamples: z.object({
    positive: z.string().trim().min(1).max(200_000),
    negative: z.string().trim().min(1).max(200_000),
    boundary: z.string().trim().min(1).max(200_000),
  }),
});
export const LearningSignalRefSchema = z.discriminatedUnion("kind", [
  DemonstrationSignalSchema,
  PreferenceSignalSchema,
  CorrectionSignalSchema,
  FeedbackSignalSchema,
  RewardSignalSchema,
  LabelSignalSchema,
]);

export const LearningSignalInventorySchema = z.object({
  demonstrations: z.array(DemonstrationSignalSchema).max(100_000).default([]),
  preferences: z.array(PreferenceSignalSchema).max(100_000).default([]),
  corrections: z.array(CorrectionSignalSchema).max(100_000).default([]),
  feedback: z.array(FeedbackSignalSchema).max(100_000).default([]),
  rewards: z.array(RewardSignalSchema).max(100_000).default([]),
  labels: z.array(LabelSignalSchema).max(100_000).default([]),
});

export const TasksetEnvironmentContractSchema = z.object({
  protocolVersion: z.literal("openpond.taskEnvironment.v1"),
  kind: z.enum(["chat", "agent", "program", "stateful_harness", "work"]),
  entrypoint: z.string().trim().min(1).max(1_000),
  stateful: z.boolean(),
  deterministicSeeds: z.boolean(),
  toolNames: z.array(IdSchema).max(200).default([]),
  actionBindings: z.array(HarnessActionBindingSchema).max(200).optional(),
  lifecycle: z.array(z.enum(["create", "reset", "step", "grade", "cleanup"])).min(1),
  defaultTimeoutMs: z.number().int().positive().max(3_600_000),
  networkPolicy: z.enum(["none", "declared_read_only", "declared_scoped"]),
  resources: z.array(TasksetEnvironmentResourceSchema).max(10_000).optional(),
  metadata: MetadataSchema,
});

export const TasksetCapabilityManifestSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetCapabilities.v1"),
  taskKind: z.enum(["chat", "single_agent", "multi_agent", "custom_program"]),
  supportedSignals: z.array(z.enum(["demonstration", "preference", "correction", "feedback", "reward", "label"])),
  compatibleMethods: z.array(z.enum(["none", "retrieval", "sft", "dpo", "grpo", "ppo", "sdft", "opd", "opsd", "sdpo"])),
  rewardKinds: z.array(z.enum(["none", "exact", "deterministic", "model_judge", "human"])),
  requiresTools: z.boolean(),
  requiresState: z.boolean(),
  requiresPrivilegedGrading: z.boolean(),
  environmentPlacements: z.array(z.enum(["local", "remote", "colocated", "provider_native"])),
  exportable: z.boolean(),
  portabilityBlockers: z.array(z.string().trim().min(1).max(2_000)).default([]),
});

export const TasksetMetricPolicySchema = z.object({
  schemaVersion: z.literal("openpond.tasksetMetricPolicy.v1"),
  primaryMetric: IdSchema,
  aggregation: z.enum(["mean_score", "pass_rate", "weighted_mean", "custom"]),
  missingReward: z.enum(["zero", "exclude"]),
  customAggregator: z.object({
    module: z.string().trim().min(1).max(1_000)
      .refine(safeRelativeFilePath, "Custom metric modules must use a safe relative path."),
    exportName: CodeIdentifierSchema,
    contentHash: Sha256Schema,
    timeoutMs: z.number().int().positive().max(300_000),
    networkPolicy: z.literal("none"),
  }).nullable(),
}).superRefine((policy, context) => {
  if (policy.aggregation === "custom" && !policy.customAggregator) {
    context.addIssue({
      code: "custom",
      message: "Custom metric aggregation requires a content-hashed module.",
      path: ["customAggregator"],
    });
  }
  if (policy.aggregation !== "custom" && policy.customAggregator) {
    context.addIssue({
      code: "custom",
      message: "Built-in metric aggregation cannot include a custom module.",
      path: ["customAggregator"],
    });
  }
});

export const TaskFailureClassSchema = z.enum([
  "policy_failure",
  "grader_failure",
  "environment_failure",
  "infrastructure_failure",
  "timeout",
  "cancelled",
]);

const GraderBaseSchema = z.object({
  id: IdSchema,
  version: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(500),
  weight: z.number().min(0).max(1_000).default(1),
  hardGate: z.boolean().default(false),
  rewardEligible: z.boolean().default(false),
  privileged: z.boolean().default(false),
  metadata: MetadataSchema,
});

export const DeterministicGraderSpecSchema = GraderBaseSchema.extend({
  kind: z.enum(["content", "schema", "file", "diff", "test", "runtime_event", "state"]),
  config: z.record(z.string(), z.unknown()),
});
export const RubricGraderSpecSchema = GraderBaseSchema.extend({
  kind: z.literal("model_judge"),
  rubric: z.string().trim().min(1).max(50_000),
  judge: ChatModelRefSchema,
  calibrationFixtureRefs: z.array(IdSchema).min(1).max(500),
  calibrationStatus: z.enum(["pending", "passed", "failed"]),
  temperature: z.number().min(0).max(2).default(0),
});
export const HumanGraderSpecSchema = GraderBaseSchema.extend({
  kind: z.literal("human"),
  rubric: z.string().trim().min(1).max(50_000),
  reviewerRole: z.string().trim().min(1).max(500),
});
export const CustomVerifierGraderSpecSchema = GraderBaseSchema.extend({
  kind: z.literal("custom_verifier"),
  module: z.string().trim().min(1).max(1_000)
    .refine(safeRelativeFilePath, "Custom verifier modules must use a safe relative path."),
  exportName: CodeIdentifierSchema,
  timeoutMs: z.number().int().positive().max(300_000),
  networkPolicy: z.literal("none"),
});
export const GraderSpecSchema = z.union([
  DeterministicGraderSpecSchema,
  RubricGraderSpecSchema,
  HumanGraderSpecSchema,
  CustomVerifierGraderSpecSchema,
]);

export const GraderFixtureLabelSchema = z.enum([
  "positive",
  "negative",
  "boundary",
  "adversarial",
  "prompt_injection",
  "infrastructure_failure",
]);
export const GraderFixtureSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  label: GraderFixtureLabelSchema,
  output: z.record(z.string(), z.unknown()),
  infrastructureError: z.string().trim().min(1).max(10_000).nullable(),
  expectedPassed: z.boolean(),
  expectedRewardEligible: z.boolean(),
  metadata: MetadataSchema,
});

export const TaskDesignFixtureTemplateSchema = z.object({
  id: IdSchema,
  taskIndex: z.number().int().nonnegative(),
  label: GraderFixtureLabelSchema,
  output: z.record(z.string(), z.unknown()),
  infrastructureError: z.string().trim().min(1).max(10_000).nullable(),
  expectedPassed: z.boolean(),
  expectedRewardEligible: z.boolean(),
  metadata: MetadataSchema,
});

export const GeneratedTaskFileSchema = z.object({
  path: z.string().trim().min(1).max(1_000),
  role: z.enum(["environment", "verifier", "fixture"]),
  content: z.string().max(250_000),
});

export const TaskAttemptResultSchema = z.object({
  schemaVersion: z.literal("openpond.taskAttempt.v1"),
  id: IdSchema,
  tasksetId: IdSchema,
  taskId: IdSchema,
  split: TasksetSplitSchema,
  attempt: z.number().int().nonnegative(),
  seed: z.number().int(),
  modelRef: ChatModelRefSchema.nullable(),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  output: z.record(z.string(), z.unknown()),
  runtimeEventRefs: z.array(IdSchema).max(10_000).default([]),
  artifactRefs: z.array(IdSchema).max(10_000).default([]),
  privilegedOutcomeRef: NullableIdSchema,
  infrastructureError: z.string().trim().min(1).max(10_000).nullable(),
  costUsd: z.number().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative(),
  userInterventions: z.number().int().nonnegative().default(0),
  metadata: MetadataSchema,
});

export const TaskAttemptArtifactSchema = z.object({
  schemaVersion: z.literal("openpond.taskAttemptArtifact.v1"),
  id: IdSchema,
  tasksetId: IdSchema,
  taskId: IdSchema,
  attemptId: IdSchema,
  kind: z.enum([
    "raw_model_response",
    "runtime_trace",
    "environment_state",
    "grader_evidence",
    "output_artifact",
  ]),
  path: z.string().trim().min(1).max(4_000),
  mediaType: z.string().trim().min(1).max(200).nullable().optional(),
  sha256: HashSchema,
  sizeBytes: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  metadata: MetadataSchema,
});

export const GradeComponentSchema = z.object({
  graderId: IdSchema,
  graderVersion: z.string().trim().min(1).max(100),
  score: z.number().min(0).max(1),
  passed: z.boolean(),
  hardGate: z.boolean(),
  rewardEligible: z.boolean(),
  feedback: z.string().trim().max(20_000).nullable(),
  evidenceRefs: z.array(IdSchema).max(10_000).default([]),
  judge: ChatModelRefSchema.nullable().optional().default(null),
  calibrationStatus: z.enum(["not_applicable", "pending", "passed", "failed"]),
});

export const GradeResultSchema = z.object({
  schemaVersion: z.literal("openpond.gradeResult.v1"),
  id: IdSchema,
  attemptId: IdSchema,
  graderSetHash: HashSchema,
  score: z.number().min(0).max(1).nullable(),
  passed: z.boolean(),
  components: z.array(GradeComponentSchema).min(1).max(1_000),
  failureClass: TaskFailureClassSchema.nullable(),
  feedback: z.array(z.string().trim().min(1).max(20_000)).max(1_000).default([]),
  rewardEligible: z.boolean(),
  createdAt: TimestampSchema,
});

export const DatasetSelectionStrategySchema = z.enum([
  "stable_hash_top_n",
  "rft_easy_curriculum_v1",
]);

export const GraderAuditReportSchema = z.object({
  schemaVersion: z.literal("openpond.graderAuditReport.v1"),
  id: IdSchema,
  tasksetId: IdSchema,
  tasksetHash: HashSchema,
  fixtureRefs: z.array(IdSchema).min(1).max(100_000),
  gradeRefs: z.array(IdSchema).min(1).max(100_000),
  passed: z.boolean(),
  hackingChecksPassed: z.boolean(),
  leakageChecksPassed: z.boolean(),
  infrastructureSafetyPassed: z.boolean(),
  failures: z.array(z.object({ fixtureId: IdSchema, label: GraderFixtureLabelSchema, gradeId: IdSchema, reason: z.string().trim().min(1).max(5_000) })).max(100_000),
  createdAt: TimestampSchema,
});

export const TrainingPathRecommendationSchema = z.object({
  primaryMethod: z.enum(["sft", "dpo", "grpo", "ppo", "sdft", "opsd", "sdpo"]),
  bootstrap: z.object({
    method: z.literal("sft"),
    purpose: z.literal("trajectory_bootstrap"),
    demonstrationRefs: z.array(IdSchema).min(1).max(100_000),
    limitations: z.array(z.string().trim().min(1).max(5_000)).min(1).max(100),
  }).nullable(),
});

export const TrainingMethodReadinessReasonCodeSchema = z.enum([
  "taskset_not_ready",
  "demonstrations_missing",
  "preference_pairs_missing",
  "preference_pairs_invalid",
  "executable_reward_missing",
  "reward_not_calibrated",
  "reward_model_missing",
  "value_model_required",
  "frozen_eval_missing",
]);

export const TrainingMethodReadinessSchema = z.object({
  method: z.enum(["sft", "dpo", "grpo", "ppo"]),
  status: z.enum(["recommended", "compatible", "needs_dataset_work"]),
  reasonCodes: z.array(TrainingMethodReadinessReasonCodeSchema).default([]),
  reasons: z.array(z.string().trim().min(1).max(5_000)).default([]),
});

export const TasksetReadinessReportSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetReadiness.v1"),
  tasksetId: IdSchema,
  tasksetHash: HashSchema,
  ready: z.boolean(),
  recommendedMethod: z.enum(["none", "retrieval", "sft", "dpo", "grpo", "ppo", "sdft", "opd", "opsd", "sdpo"]),
  trainingPath: TrainingPathRecommendationSchema.nullable().default(null),
  methodReadiness: z.array(TrainingMethodReadinessSchema).default([]),
  compatibleDestinationClasses: z.array(
    z.enum(["export", "custom", "hosted_managed"]),
  ),
  blockers: z.array(z.object({ code: IdSchema, message: z.string().trim().min(1).max(5_000), path: z.string().trim().max(2_000).nullable() })).default([]),
  warnings: z.array(z.string().trim().min(1).max(5_000)).default([]),
  generatedAt: TimestampSchema,
});

export const CapabilityDiagnosisSchema = z.object({
  schemaVersion: z.literal("openpond.capabilityDiagnosis.v1"),
  summary: z.string().trim().min(1).max(10_000),
  stableBehavior: z.array(z.string().trim().min(1).max(5_000)).max(100).default([]),
  changingKnowledge: z.array(z.string().trim().min(1).max(5_000)).max(100).default([]),
  requiredContext: z.array(z.string().trim().min(1).max(5_000)).max(100).default([]),
  requiredTools: z.array(IdSchema).max(100).default([]),
  intervention: TrainingTacticSchema,
  trainingEligible: z.boolean(),
  rationale: z.array(z.string().trim().min(1).max(5_000)).min(1).max(100),
  confidence: z.number().min(0).max(1),
});

export const TaskExampleProposalSchema = z.object({
  id: IdSchema,
  sourceId: IdSchema,
  sourceTurnId: NullableIdSchema,
  split: TasksetSplitSchema,
  origin: z.enum(["extracted", "corrected", "synthetic", "expert_authored"]),
  inputPrompt: z.string().trim().min(1).max(100_000),
  expectedOutputText: z.string().trim().min(1).max(200_000).nullable(),
  rationale: z.string().trim().min(1).max(5_000),
});

export const AuthoringRepairSchema = z.object({ attempt: z.number().int().positive(), summary: z.string().trim().min(1).max(5_000), createdAt: TimestampSchema });
export const AuthoringProvenanceSchema = z.object({
  schemaVersion: z.literal("openpond.taskAuthoringProvenance.v1"),
  model: ChatModelRefSchema.nullable(),
  modelConfig: MetadataSchema,
  skillHash: HashSchema,
  promptTemplateVersion: z.string().trim().min(1).max(200),
  buildIntent: DatasetBuildIntentSchema.default("demonstrations"),
  buildSpecification: DatasetBuildSpecificationSchema.nullable().default(null),
  evidenceHashes: z.array(HashSchema).max(100_000),
  tasksetSdkVersion: z.string().trim().min(1).max(100),
  sourceCommit: z.string().trim().min(1).max(256).nullable(),
  repairHistory: z.array(AuthoringRepairSchema).max(1_000),
  createdAt: TimestampSchema,
});

export const TasksetSchema = z.object({
  schemaVersion: z.literal("openpond.taskset.v1"),
  id: IdSchema,
  revision: z.number().int().positive().default(1),
  profileId: IdSchema,
  profileRelease: VersionedReleaseRefSchema.nullable().optional(),
  createImproveRunId: NullableIdSchema.default(null),
  name: z.string().trim().min(1).max(500),
  objective: z.string().trim().min(1).max(20_000),
  purpose: TasksetPurposeSchema.default("general"),
  benchmark: TasksetBenchmarkBindingSchema.nullable().default(null),
  preferenceComparison: TasksetPreferenceComparisonBindingSchema.nullable().default(null),
  status: TasksetStatusSchema,
  sourceRefs: z.array(TasksetSourceRefSchema).min(1).max(100_000),
  datasetArtifact: DatasetArtifactManifestSchema.nullable().optional(),
  policy: TaskPolicyBoundarySchema,
  environment: TasksetEnvironmentContractSchema,
  capabilities: TasksetCapabilityManifestSchema,
  metrics: TasksetMetricPolicySchema.optional(),
  tasks: z.array(TaskDataRecordSchema).max(1_000_000),
  graders: z.array(GraderSpecSchema).min(1).max(1_000),
  graderFixtures: z.array(GraderFixtureSchema).min(1).max(100_000),
  learningSignals: LearningSignalInventorySchema,
  authoringProvenance: AuthoringProvenanceSchema,
  readiness: TasksetReadinessReportSchema.nullable(),
  contentHash: HashSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  metadata: MetadataSchema,
}).superRefine((taskset, context) => {
  if (taskset.purpose === "benchmark" && !taskset.benchmark) {
    context.addIssue({
      code: "custom",
      message: "Benchmark Tasksets require an immutable benchmark binding.",
      path: ["benchmark"],
    });
  }
  if (taskset.purpose !== "benchmark" && taskset.benchmark) {
    context.addIssue({
      code: "custom",
      message: "Only benchmark Tasksets may carry a benchmark binding.",
      path: ["benchmark"],
    });
  }
  if (taskset.datasetArtifact && taskset.tasks.length > 0) {
    context.addIssue({
      code: "custom",
      message:
        "Artifact-backed Tasksets may not duplicate canonical rows inline.",
      path: ["tasks"],
    });
  }
  if (!taskset.datasetArtifact && taskset.tasks.length === 0) {
    context.addIssue({
      code: "custom",
      message: "A Taskset requires inline tasks or a Dataset artifact manifest.",
      path: ["tasks"],
    });
  }
});

export const TaskDesignProposalSchema = z.object({
  schemaVersion: z.literal("openpond.taskDesignProposal.v1"),
  id: IdSchema,
  name: z.string().trim().min(1).max(500),
  objective: z.string().trim().min(1).max(20_000),
  diagnosis: CapabilityDiagnosisSchema.default({
    schemaVersion: "openpond.capabilityDiagnosis.v1",
    summary: "Reproduce the selected approved behavior.",
    stableBehavior: [],
    changingKnowledge: [],
    requiredContext: [],
    requiredTools: [],
    intervention: "sft",
    trainingEligible: true,
    rationale: ["The selected examples were supplied as demonstrations."],
    confidence: 0.5,
  }),
  taskKind: TasksetCapabilityManifestSchema.shape.taskKind,
  sourceIds: z.array(IdSchema).min(1).max(100_000),
  assumptions: z.array(z.string().trim().min(1).max(5_000)).max(1_000),
  successCriteria: z.array(z.string().trim().min(1).max(5_000)).min(1).max(1_000),
  proposedGraders: z.array(GraderSpecSchema).max(1_000).default([]),
  graderFixtures: z.array(TaskDesignFixtureTemplateSchema).max(100_000).default([]),
  generatedFiles: z.array(GeneratedTaskFileSchema).max(1_000).default([]),
  proposedExamples: z.array(TaskExampleProposalSchema).max(100_000).default([]),
  proposedMethod: TasksetReadinessReportSchema.shape.recommendedMethod,
  trainingPath: TrainingPathRecommendationSchema.nullable().default(null),
  policy: TaskPolicyBoundarySchema,
  warnings: z.array(z.string().trim().min(1).max(5_000)).default([]),
  createdAt: TimestampSchema,
});

/**
 * Hosted Taskset authoring includes the authoring skill and the proposal JSON
 * schema in addition to the selected evidence. Keep the raw-evidence portion
 * bounded so a disclosure cannot monopolize the hosted gateway or fail after
 * the private excerpts have already been sent.
 */
export const TASK_AUTHORING_MAX_DISCLOSED_EVIDENCE_TOKENS = 48_000;
export const WORKPRODUCT_NAME_MAX_WORDS = 5;

export function conciseWorkproductName(
  value: string | null | undefined,
  fallback = "New model",
): string {
  const words = value?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length === 0) return fallback;
  return words.slice(0, WORKPRODUCT_NAME_MAX_WORDS).join(" ");
}

export const BaseModelPreferenceSchema = z.object({
  schemaVersion: z.literal("openpond.baseModelPreference.v1"),
  modelId: IdSchema,
  revision: z.string().trim().min(1).max(256).nullable(),
  tokenizerRevision: z.string().trim().min(1).max(256).nullable(),
  chatTemplateHash: z.string().trim().min(8).max(256).nullable(),
  modelAssetId: NullableIdSchema,
  source: z.enum(["managed", "local", "builtin"]),
});

export const TaskCreationRequestSchema = z.object({
  schemaVersion: z.literal("openpond.taskCreationRequest.v1"),
  id: IdSchema,
  profileId: IdSchema,
  surface: TaskCreationSurfaceSchema,
  mode: TaskCreationModeSchema,
  entryMode: NewModelModeSchema.default("manual"),
  resourceIntent: z.enum(["workproduct", "dataset"]).default("workproduct"),
  buildIntent: DatasetBuildIntentSchema.default("demonstrations"),
  buildSpecification: DatasetBuildSpecificationSchema.nullable().default(null),
  objective: z.string().trim().min(1).max(20_000).nullable(),
  methodHint: z.enum(["sft", "dpo", "grpo", "ppo"]).nullable().default(null),
  preferredBaseModelId: IdSchema.nullable().default(null),
  preferredBaseModel: BaseModelPreferenceSchema.nullable().default(null),
  sourceIds: z.array(IdSchema).max(100_000),
  candidateId: NullableIdSchema,
  analysisModel: ChatModelRefSchema.nullable(),
  analysisReasoningEffort: CodexReasoningEffortSchema.nullable().default(null),
  createImproveRunId: NullableIdSchema.default(null),
  targetIntent: z.object({
    kind: z.enum(["agent", "skill", "extension", "model", "configuration"]).nullable(),
    id: NullableIdSchema,
    displayName: z.string().trim().min(1).max(500).nullable(),
    operation: z.enum(["create", "improve"]),
  }).default({ kind: "model", id: null, displayName: null, operation: "create" }),
  disclosure: z.object({
    status: z.enum(["not_required", "pending", "approved", "declined"]),
    content: z.literal("raw_excerpts"),
    sourceIds: z.array(IdSchema).max(100_000),
    providerModel: ChatModelRefSchema.nullable(),
    approvalId: NullableIdSchema,
    approvedAt: TimestampSchema.nullable(),
  }).default({ status: "not_required", content: "raw_excerpts", sourceIds: [], providerModel: null, approvalId: null, approvedAt: null }),
  createdAt: TimestampSchema,
});

export const TaskCreationSnapshotSchema = z.object({
  schemaVersion: z.literal("openpond.taskCreationSnapshot.v1"),
  id: IdSchema,
  request: TaskCreationRequestSchema,
  state: z.enum(["planning", "awaiting_disclosure_approval", "awaiting_questions", "recommendation_ready", "awaiting_materialization_approval", "materializing", "validating", "ready", "blocked", "failed", "cancelled"]),
  proposal: TaskDesignProposalSchema.nullable(),
  materializedTasksetId: NullableIdSchema,
  disclosureApprovalId: NullableIdSchema,
  materializationApprovalId: NullableIdSchema,
  blockingQuestions: z.array(z.object({ id: IdSchema, kind: z.enum(["objective", "consent", "success_signal", "privacy_licensing", "interpretation"]), prompt: z.string().trim().min(1).max(5_000), answer: z.string().trim().min(1).max(20_000).nullable() })).default([]),
  transcript: z.array(z.object({ id: IdSchema, role: z.enum(["user", "assistant", "system", "tool"]), text: z.string().max(100_000), createdAt: TimestampSchema })).max(10_000).default([]),
  repairHistory: z.array(AuthoringRepairSchema).max(1_000).default([]),
  blockedReason: z.string().trim().min(1).max(10_000).nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const TaskCreationTranscriptSchema = z.object({
  schemaVersion: z.literal("openpond.taskCreationTranscript.v1"),
  creationId: IdSchema,
  profileId: IdSchema,
  messages: TaskCreationSnapshotSchema.shape.transcript,
  updatedAt: TimestampSchema,
});

export type TrainingSourceRef = z.infer<typeof TrainingSourceRefSchema>;
export type TasksetSourceRef = z.infer<typeof TasksetSourceRefSchema>;
export type TrainingSourceEstimate = z.infer<typeof TrainingSourceEstimateSchema>;
export type TrainingChatSearchRequest = z.infer<typeof TrainingChatSearchRequestSchema>;
export type TrainingChatSearchEntry = z.infer<typeof TrainingChatSearchEntrySchema>;
export type TrainingChatSearchResult = z.infer<typeof TrainingChatSearchResultSchema>;
export type TaskCreationSurface = z.infer<typeof TaskCreationSurfaceSchema>;
export type TaskCreationMode = z.infer<typeof TaskCreationModeSchema>;
export type NewModelMode = z.infer<typeof NewModelModeSchema>;
export type DatasetBuildIntent = z.infer<typeof DatasetBuildIntentSchema>;
export type DatasetBuildSpecification = z.infer<typeof DatasetBuildSpecificationSchema>;
export type TaskAssetRef = z.infer<typeof TaskAssetRefSchema>;
export type TaskRequiredOutput = z.infer<typeof TaskRequiredOutputSchema>;
export type TaskDataRecord = z.infer<typeof TaskDataRecordSchema>;
export type TasksetEnvironmentResource = z.infer<typeof TasksetEnvironmentResourceSchema>;
export type DemonstrationSignal = z.infer<typeof DemonstrationSignalSchema>;
export type PreferenceSignal = z.infer<typeof PreferenceSignalSchema>;
export type CorrectionSignal = z.infer<typeof CorrectionSignalSchema>;
export type FeedbackSignal = z.infer<typeof FeedbackSignalSchema>;
export type RewardSignal = z.infer<typeof RewardSignalSchema>;
export type LabelSignal = z.infer<typeof LabelSignalSchema>;
export type LearningSignalInventory = z.infer<typeof LearningSignalInventorySchema>;
export type TasksetEnvironmentContract = z.infer<typeof TasksetEnvironmentContractSchema>;
export type TasksetCapabilityManifest = z.infer<typeof TasksetCapabilityManifestSchema>;
export type TasksetMetricPolicy = z.infer<typeof TasksetMetricPolicySchema>;
export type TaskFailureClass = z.infer<typeof TaskFailureClassSchema>;
export type GraderSpec = z.infer<typeof GraderSpecSchema>;
export type GraderFixture = z.infer<typeof GraderFixtureSchema>;
export type TaskDesignFixtureTemplate = z.infer<typeof TaskDesignFixtureTemplateSchema>;
export type GeneratedTaskFile = z.infer<typeof GeneratedTaskFileSchema>;
export type TaskAttemptResult = z.infer<typeof TaskAttemptResultSchema>;
export type TaskAttemptArtifact = z.infer<typeof TaskAttemptArtifactSchema>;
export type GradeComponent = z.infer<typeof GradeComponentSchema>;
export type GradeResult = z.infer<typeof GradeResultSchema>;
export type DatasetSelectionStrategy = z.infer<typeof DatasetSelectionStrategySchema>;
export type GraderAuditReport = z.infer<typeof GraderAuditReportSchema>;
export type TrainingPathRecommendation = z.infer<typeof TrainingPathRecommendationSchema>;
export type TrainingMethodReadinessReasonCode = z.infer<typeof TrainingMethodReadinessReasonCodeSchema>;
export type TrainingMethodReadiness = z.infer<typeof TrainingMethodReadinessSchema>;
export type TasksetReadinessReport = z.infer<typeof TasksetReadinessReportSchema>;
export type CapabilityDiagnosis = z.infer<typeof CapabilityDiagnosisSchema>;
export type TaskExampleProposal = z.infer<typeof TaskExampleProposalSchema>;
export type AuthoringProvenance = z.infer<typeof AuthoringProvenanceSchema>;
export type AuthoringRepair = z.infer<typeof AuthoringRepairSchema>;
export type Taskset = z.infer<typeof TasksetSchema>;
export type TasksetPurpose = z.infer<typeof TasksetPurposeSchema>;
export type TasksetBenchmarkBinding = z.infer<typeof TasksetBenchmarkBindingSchema>;
export type TaskDesignProposal = z.infer<typeof TaskDesignProposalSchema>;
export type TaskCreationTranscript = z.infer<typeof TaskCreationTranscriptSchema>;
export type BaseModelPreference = z.infer<typeof BaseModelPreferenceSchema>;
export type TaskCreationRequest = z.infer<typeof TaskCreationRequestSchema>;
export type TaskCreationSnapshot = z.infer<typeof TaskCreationSnapshotSchema>;

export function isTrainingSourceRef(
  source: TasksetSourceRef,
): source is TrainingSourceRef {
  return source.schemaVersion === "openpond.trainingSource.v1";
}
