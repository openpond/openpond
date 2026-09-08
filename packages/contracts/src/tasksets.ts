import { z } from "zod";
import { TASKSET_WORK_TOOL_NAMES, TasksetStatusSchema, DatasetBuildIntentSchema, DatasetBuildSpecificationSchema, GeneratedTaskFileSchema, TrainingPathRecommendationSchema, TrainingMethodReadinessReasonCodeSchema, TrainingMethodReadinessSchema, TasksetReadinessFindingSchema, TasksetReadinessReportSchema, AuthoringRepairSchema, AuthoringProvenanceSchema, TasksetSchema, type DatasetBuildIntent, type DatasetBuildSpecification, type GeneratedTaskFile, type TrainingPathRecommendation, type TrainingMethodReadinessReasonCode, type TrainingMethodReadiness, type TasksetReadinessReport, type AuthoringProvenance, type AuthoringRepair, type Taskset } from "openpond-sdk/taskset-drafts";
export { TASKSET_WORK_TOOL_NAMES, TasksetStatusSchema, DatasetBuildIntentSchema, DatasetBuildSpecificationSchema, GeneratedTaskFileSchema, TrainingPathRecommendationSchema, TrainingMethodReadinessReasonCodeSchema, TrainingMethodReadinessSchema, TasksetReadinessFindingSchema, TasksetReadinessReportSchema, AuthoringRepairSchema, AuthoringProvenanceSchema, TasksetSchema, type DatasetBuildIntent, type DatasetBuildSpecification, type GeneratedTaskFile, type TrainingPathRecommendation, type TrainingMethodReadinessReasonCode, type TrainingMethodReadiness, type TasksetReadinessReport, type AuthoringProvenance, type AuthoringRepair, type Taskset };
export { isTrainingSourceRef } from "openpond-sdk/taskset-drafts";
import {
  TasksetSplitSchema,
  TasksetPurposeSchema,
  TasksetBenchmarkBindingSchema,
  TasksetPreferenceComparisonBindingSchema,
  TrainingSourceConsentSchema,
  TrainingSourceRefSchema,
  TasksetSourceRefSchema,
  TaskPolicyBoundarySchema,
  TaskAssetRefSchema,
  TaskRequiredOutputSchema,
  TaskDataRecordSchema,
  TasksetEnvironmentResourceSchema,
  DemonstrationSignalSchema,
  PreferenceSignalSchema,
  CorrectionSignalSchema,
  FeedbackSignalSchema,
  RewardSignalSchema,
  LabelSignalSchema,
  LearningSignalRefSchema,
  LearningSignalInventorySchema,
  TasksetEnvironmentContractSchema,
  TasksetCapabilityManifestSchema,
  DeterministicGraderSpecSchema,
  RubricGraderSpecSchema,
  HumanGraderSpecSchema,
  CustomVerifierGraderSpecSchema,
  GraderSpecSchema,
  GraderFixtureLabelSchema,
  GraderFixtureSchema,
  type TrainingSourceRef,
  type TasksetSourceRef,
  type TaskAssetRef,
  type TaskRequiredOutput,
  type TaskDataRecord,
  type TasksetEnvironmentResource,
  type DemonstrationSignal,
  type PreferenceSignal,
  type CorrectionSignal,
  type FeedbackSignal,
  type RewardSignal,
  type LabelSignal,
  type LearningSignalInventory,
  type TasksetEnvironmentContract,
  type TasksetCapabilityManifest,
  type GraderSpec,
  type GraderFixture,
  type TasksetPurpose,
  type TasksetBenchmarkBinding,
} from "openpond-sdk/taskset-drafts";
export {
  TasksetSplitSchema,
  TasksetPurposeSchema,
  TasksetBenchmarkBindingSchema,
  TasksetPreferenceComparisonBindingSchema,
  TrainingSourceConsentSchema,
  TrainingSourceRefSchema,
  TasksetSourceRefSchema,
  TaskPolicyBoundarySchema,
  TaskAssetRefSchema,
  TaskRequiredOutputSchema,
  TaskDataRecordSchema,
  TasksetEnvironmentResourceSchema,
  DemonstrationSignalSchema,
  PreferenceSignalSchema,
  CorrectionSignalSchema,
  FeedbackSignalSchema,
  RewardSignalSchema,
  LabelSignalSchema,
  LearningSignalRefSchema,
  LearningSignalInventorySchema,
  TasksetEnvironmentContractSchema,
  TasksetCapabilityManifestSchema,
  DeterministicGraderSpecSchema,
  RubricGraderSpecSchema,
  HumanGraderSpecSchema,
  CustomVerifierGraderSpecSchema,
  GraderSpecSchema,
  GraderFixtureLabelSchema,
  GraderFixtureSchema,
  type TrainingSourceRef,
  type TasksetSourceRef,
  type TaskAssetRef,
  type TaskRequiredOutput,
  type TaskDataRecord,
  type TasksetEnvironmentResource,
  type DemonstrationSignal,
  type PreferenceSignal,
  type CorrectionSignal,
  type FeedbackSignal,
  type RewardSignal,
  type LabelSignal,
  type LearningSignalInventory,
  type TasksetEnvironmentContract,
  type TasksetCapabilityManifest,
  type GraderSpec,
  type GraderFixture,
  type TasksetPurpose,
  type TasksetBenchmarkBinding,
};
import { RewardCompositionSchema } from "@openpond/evals/rewards";
import { TasksetMetricPolicySchema } from "@openpond/evals/metrics";
export { TasksetMetricPolicySchema } from "@openpond/evals/metrics";
import { ChatModelRefSchema } from "./providers.js";
import { CodexReasoningEffortSchema } from "./settings.js";
import { TrainingTacticSchema } from "./task-mining.js";
import { VersionedReleaseRefSchema } from "./release-core.js";

const IdSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().trim().min(1);
const HashSchema = z.string().trim().min(8).max(256);
const MetadataSchema = z.record(z.string(), z.unknown()).default({});
const NullableIdSchema = IdSchema.nullable();
export const TaskCreationSurfaceSchema = z.enum([
  "slash_train",
  "session_menu",
  "bulk_selection",
  "training_page",
  "task_candidate",
]);
export const TaskCreationModeSchema = z.enum(["defaults", "customize"]);
export const NewModelModeSchema = z.enum(["automated", "manual"]);

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

export const TaskFailureClassSchema = z.enum([
  "policy_failure",
  "grader_failure",
  "environment_failure",
  "infrastructure_failure",
  "timeout",
  "cancelled",
]);

export const TasksetGraderSourceSchema = z.object({
  graderId: IdSchema.nullable(),
  path: z.string().trim().min(1).max(1_000),
  language: z.enum(["javascript", "typescript", "python", "json", "text"]),
  content: z.string().max(2_000_000),
  sha256: HashSchema,
  declaredSha256: HashSchema.nullable(),
  integrity: z.enum(["verified", "unverified", "mismatch"]),
});

export const TasksetGraderRuntimeSchema = z.object({
  protocolVersion: z.string().trim().min(1).max(200),
  module: z.string().trim().min(1).max(1_000),
  moduleSha256: HashSchema,
  command: z.array(z.string().max(2_000)).max(100),
  cwd: z.string().trim().min(1).max(4_000),
  maxTurns: z.number().int().positive().max(100),
});

export const TasksetGraderDetailsResponseSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetGraderDetails.v1"),
  taskset: VersionedReleaseRefSchema,
  sourceTasksetId: IdSchema,
  graders: z.array(GraderSpecSchema).max(1_000),
  runtime: TasksetGraderRuntimeSchema.nullable(),
  sources: z.array(TasksetGraderSourceSchema).max(1_000),
  unavailableReason: z.string().max(2_000).nullable(),
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
  score: z.number().min(0).max(1).nullable(),
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
  rewardComposition: RewardCompositionSchema.optional(),
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
export type TrainingSourceEstimate = z.infer<typeof TrainingSourceEstimateSchema>;
export type TrainingChatSearchRequest = z.infer<typeof TrainingChatSearchRequestSchema>;
export type TrainingChatSearchEntry = z.infer<typeof TrainingChatSearchEntrySchema>;
export type TrainingChatSearchResult = z.infer<typeof TrainingChatSearchResultSchema>;
export type TaskCreationSurface = z.infer<typeof TaskCreationSurfaceSchema>;
export type TaskCreationMode = z.infer<typeof TaskCreationModeSchema>;
export type NewModelMode = z.infer<typeof NewModelModeSchema>;
export type TasksetMetricPolicy = z.infer<typeof TasksetMetricPolicySchema>;
export type TaskFailureClass = z.infer<typeof TaskFailureClassSchema>;
export type TasksetGraderDetailsResponse = z.infer<typeof TasksetGraderDetailsResponseSchema>;
export type TaskDesignFixtureTemplate = z.infer<typeof TaskDesignFixtureTemplateSchema>;
export type TaskAttemptResult = z.infer<typeof TaskAttemptResultSchema>;
export type TaskAttemptArtifact = z.infer<typeof TaskAttemptArtifactSchema>;
export type GradeComponent = z.infer<typeof GradeComponentSchema>;
export type GradeResult = z.infer<typeof GradeResultSchema>;
export type DatasetSelectionStrategy = z.infer<typeof DatasetSelectionStrategySchema>;
export type GraderAuditReport = z.infer<typeof GraderAuditReportSchema>;
export type CapabilityDiagnosis = z.infer<typeof CapabilityDiagnosisSchema>;
export type TaskExampleProposal = z.infer<typeof TaskExampleProposalSchema>;
export type TaskDesignProposal = z.infer<typeof TaskDesignProposalSchema>;
export type TaskCreationTranscript = z.infer<typeof TaskCreationTranscriptSchema>;
export type BaseModelPreference = z.infer<typeof BaseModelPreferenceSchema>;
export type TaskCreationRequest = z.infer<typeof TaskCreationRequestSchema>;
export type TaskCreationSnapshot = z.infer<typeof TaskCreationSnapshotSchema>;
