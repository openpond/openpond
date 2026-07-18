import { z } from "zod";
import { ChatModelRefSchema } from "./providers.js";
import { CodexReasoningEffortSchema } from "./settings.js";
import { TrainingTacticSchema } from "./task-mining.js";

const IdSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().trim().min(1);
const HashSchema = z.string().trim().min(8).max(256);
const MetadataSchema = z.record(z.string(), z.unknown()).default({});
const NullableIdSchema = IdSchema.nullable();

export const TasksetSplitSchema = z.enum(["train", "validation", "test", "frozen_eval"]);
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
export const TaskCreationSurfaceSchema = z.enum([
  "slash_train",
  "session_menu",
  "bulk_selection",
  "training_page",
  "task_candidate",
]);
export const TaskCreationModeSchema = z.enum(["defaults", "customize"]);
export const NewModelModeSchema = z.enum(["automated", "manual"]);

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
  tags: z.array(IdSchema).max(100).default([]),
  metadata: MetadataSchema,
});

export const LearningSignalRefSchema = z.object({
  id: IdSchema,
  kind: z.enum(["demonstration", "preference", "correction", "feedback", "reward", "label"]),
  taskId: NullableIdSchema,
  sourceRefs: z.array(IdSchema).min(1).max(100),
  artifactRef: IdSchema,
  approved: z.boolean(),
  confidence: z.number().min(0).max(1),
  metadata: MetadataSchema,
});

export const LearningSignalInventorySchema = z.object({
  demonstrations: z.array(LearningSignalRefSchema).max(100_000).default([]),
  preferences: z.array(LearningSignalRefSchema).max(100_000).default([]),
  corrections: z.array(LearningSignalRefSchema).max(100_000).default([]),
  feedback: z.array(LearningSignalRefSchema).max(100_000).default([]),
  rewards: z.array(LearningSignalRefSchema).max(100_000).default([]),
  labels: z.array(LearningSignalRefSchema).max(100_000).default([]),
});

export const TasksetEnvironmentContractSchema = z.object({
  protocolVersion: z.literal("openpond.taskEnvironment.v1"),
  kind: z.enum(["chat", "agent", "program", "stateful_harness"]),
  entrypoint: z.string().trim().min(1).max(1_000),
  stateful: z.boolean(),
  deterministicSeeds: z.boolean(),
  toolNames: z.array(IdSchema).max(200).default([]),
  lifecycle: z.array(z.enum(["create", "reset", "step", "grade", "cleanup"])).min(1),
  defaultTimeoutMs: z.number().int().positive().max(3_600_000),
  networkPolicy: z.enum(["none", "declared_read_only", "declared_scoped"]),
  metadata: MetadataSchema,
});

export const TasksetCapabilityManifestSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetCapabilities.v1"),
  taskKind: z.enum(["chat", "single_agent", "multi_agent", "custom_program"]),
  supportedSignals: z.array(z.enum(["demonstration", "preference", "correction", "feedback", "reward", "label"])),
  compatibleMethods: z.array(z.enum(["none", "retrieval", "sft", "dpo", "grpo", "sdft", "opd", "opsd", "sdpo"])),
  rewardKinds: z.array(z.enum(["none", "exact", "deterministic", "model_judge", "human"])),
  requiresTools: z.boolean(),
  requiresState: z.boolean(),
  requiresPrivilegedGrading: z.boolean(),
  environmentPlacements: z.array(z.enum(["local", "remote", "colocated", "provider_native"])),
  exportable: z.boolean(),
  portabilityBlockers: z.array(z.string().trim().min(1).max(2_000)).default([]),
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
  module: z.string().trim().min(1).max(1_000),
  exportName: IdSchema,
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
  kind: z.enum(["raw_model_response", "runtime_trace", "environment_state", "grader_evidence"]),
  path: z.string().trim().min(1).max(4_000),
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

export const BaselineRewardSummarySchema = z.object({
  count: z.number().int().nonnegative(),
  mean: z.number().min(0).max(1).nullable(),
  min: z.number().min(0).max(1).nullable(),
  max: z.number().min(0).max(1).nullable(),
  variance: z.number().nonnegative().nullable(),
});

export const BaselineReportSchema = z.object({
  schemaVersion: z.literal("openpond.baselineReport.v1"),
  id: IdSchema,
  tasksetId: IdSchema,
  tasksetHash: HashSchema,
  graderSetHash: HashSchema,
  attemptRefs: z.array(IdSchema).min(1).max(1_000_000),
  gradeRefs: z.array(IdSchema).min(1).max(1_000_000),
  passAtK: z.record(z.string(), z.number().min(0).max(1)),
  reward: BaselineRewardSummarySchema,
  failureClusters: z.record(z.string(), z.number().int().nonnegative()),
  totalCostUsd: z.number().nonnegative().nullable(),
  userInterventions: z.number().int().nonnegative(),
  hackingChecksPassed: z.boolean(),
  leakageChecksPassed: z.boolean(),
  createdAt: TimestampSchema,
});

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
  primaryMethod: z.enum(["sft", "dpo", "grpo", "sdft", "opsd", "sdpo"]),
  bootstrap: z.object({
    method: z.literal("sft"),
    purpose: z.literal("trajectory_bootstrap"),
    demonstrationRefs: z.array(IdSchema).min(1).max(100_000),
    limitations: z.array(z.string().trim().min(1).max(5_000)).min(1).max(100),
  }).nullable(),
});

export const TasksetReadinessReportSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetReadiness.v1"),
  tasksetId: IdSchema,
  tasksetHash: HashSchema,
  ready: z.boolean(),
  recommendedMethod: z.enum(["none", "retrieval", "sft", "dpo", "grpo", "sdft", "opd", "opsd", "sdpo"]),
  trainingPath: TrainingPathRecommendationSchema.nullable().default(null),
  compatibleDestinationClasses: z.array(z.enum(["export", "local_cpu_fixture", "custom", "openpond_managed", "hosted_byok"])),
  blockers: z.array(z.object({ code: IdSchema, message: z.string().trim().min(1).max(5_000), path: z.string().trim().max(2_000).nullable() })).default([]),
  warnings: z.array(z.string().trim().min(1).max(5_000)).default([]),
  baselineReportId: NullableIdSchema,
  baselineReward: BaselineRewardSummarySchema.nullable().default(null),
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
  createImproveRunId: NullableIdSchema.default(null),
  name: z.string().trim().min(1).max(500),
  objective: z.string().trim().min(1).max(20_000),
  status: TasksetStatusSchema,
  sourceRefs: z.array(TrainingSourceRefSchema).min(1).max(100_000),
  policy: TaskPolicyBoundarySchema,
  environment: TasksetEnvironmentContractSchema,
  capabilities: TasksetCapabilityManifestSchema,
  tasks: z.array(TaskDataRecordSchema).min(1).max(1_000_000),
  graders: z.array(GraderSpecSchema).min(1).max(1_000),
  graderFixtures: z.array(GraderFixtureSchema).min(1).max(100_000),
  learningSignals: LearningSignalInventorySchema,
  authoringProvenance: AuthoringProvenanceSchema,
  readiness: TasksetReadinessReportSchema.nullable(),
  contentHash: HashSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  metadata: MetadataSchema,
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

export const TaskCreationRequestSchema = z.object({
  schemaVersion: z.literal("openpond.taskCreationRequest.v1"),
  id: IdSchema,
  profileId: IdSchema,
  surface: TaskCreationSurfaceSchema,
  mode: TaskCreationModeSchema,
  entryMode: NewModelModeSchema.default("manual"),
  resourceIntent: z.enum(["workproduct", "dataset"]).default("workproduct"),
  objective: z.string().trim().min(1).max(20_000).nullable(),
  methodHint: z.enum(["sft", "dpo", "grpo"]).nullable().default(null),
  preferredBaseModelId: IdSchema.nullable().default(null),
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
export type TrainingSourceEstimate = z.infer<typeof TrainingSourceEstimateSchema>;
export type TrainingChatSearchRequest = z.infer<typeof TrainingChatSearchRequestSchema>;
export type TrainingChatSearchEntry = z.infer<typeof TrainingChatSearchEntrySchema>;
export type TrainingChatSearchResult = z.infer<typeof TrainingChatSearchResultSchema>;
export type TaskCreationSurface = z.infer<typeof TaskCreationSurfaceSchema>;
export type TaskCreationMode = z.infer<typeof TaskCreationModeSchema>;
export type NewModelMode = z.infer<typeof NewModelModeSchema>;
export type TaskDataRecord = z.infer<typeof TaskDataRecordSchema>;
export type LearningSignalInventory = z.infer<typeof LearningSignalInventorySchema>;
export type TasksetEnvironmentContract = z.infer<typeof TasksetEnvironmentContractSchema>;
export type TasksetCapabilityManifest = z.infer<typeof TasksetCapabilityManifestSchema>;
export type GraderSpec = z.infer<typeof GraderSpecSchema>;
export type GraderFixture = z.infer<typeof GraderFixtureSchema>;
export type TaskDesignFixtureTemplate = z.infer<typeof TaskDesignFixtureTemplateSchema>;
export type GeneratedTaskFile = z.infer<typeof GeneratedTaskFileSchema>;
export type TaskAttemptResult = z.infer<typeof TaskAttemptResultSchema>;
export type TaskAttemptArtifact = z.infer<typeof TaskAttemptArtifactSchema>;
export type GradeComponent = z.infer<typeof GradeComponentSchema>;
export type GradeResult = z.infer<typeof GradeResultSchema>;
export type BaselineReport = z.infer<typeof BaselineReportSchema>;
export type GraderAuditReport = z.infer<typeof GraderAuditReportSchema>;
export type TrainingPathRecommendation = z.infer<typeof TrainingPathRecommendationSchema>;
export type TasksetReadinessReport = z.infer<typeof TasksetReadinessReportSchema>;
export type CapabilityDiagnosis = z.infer<typeof CapabilityDiagnosisSchema>;
export type TaskExampleProposal = z.infer<typeof TaskExampleProposalSchema>;
export type AuthoringProvenance = z.infer<typeof AuthoringProvenanceSchema>;
export type AuthoringRepair = z.infer<typeof AuthoringRepairSchema>;
export type Taskset = z.infer<typeof TasksetSchema>;
export type TaskDesignProposal = z.infer<typeof TaskDesignProposalSchema>;
export type TaskCreationTranscript = z.infer<typeof TaskCreationTranscriptSchema>;
export type TaskCreationRequest = z.infer<typeof TaskCreationRequestSchema>;
export type TaskCreationSnapshot = z.infer<typeof TaskCreationSnapshotSchema>;
