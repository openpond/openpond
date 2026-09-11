import { z } from "zod";
import { ChatModelRefSchema } from "@openpond/harness/models";
import { CustomVerifierRuntimeSchema } from "@openpond/evals/tasksets";
import { DatasetSplitSchema } from "./taskset-draft-dataset-artifacts.js";
import { ExternalDatasetSourceRefSchema } from "./taskset-draft-dataset-sources.js";
import { HarnessActionBindingSchema } from "./taskset-draft-harness-actions.js";

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

export const TasksetPreferenceComparisonBindingSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetPreferenceComparisonBinding.v1"),
  releaseId: IdSchema,
  releaseHash: Sha256Schema,
  publishedAt: TimestampSchema,
  metadata: MetadataSchema,
});

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
  runtime: CustomVerifierRuntimeSchema.optional(),
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

export type TrainingSourceRef = z.infer<typeof TrainingSourceRefSchema>;
export type TasksetSourceRef = z.infer<typeof TasksetSourceRefSchema>;
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
export type GraderSpec = z.infer<typeof GraderSpecSchema>;
export type GraderFixture = z.infer<typeof GraderFixtureSchema>;
export type TasksetPurpose = z.infer<typeof TasksetPurposeSchema>;
export type TasksetBenchmarkBinding = z.infer<typeof TasksetBenchmarkBindingSchema>;
