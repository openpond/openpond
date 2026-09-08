import { z } from "zod";
import { VersionedReleaseRefSchema } from "@openpond/harness";
import { ChatModelRefSchema } from "@openpond/harness/models";
import { TasksetMetricPolicySchema } from "@openpond/evals/metrics";
import { DatasetArtifactManifestSchema } from "./taskset-draft-dataset-artifacts.js";
import {
  TasksetPurposeSchema,
  TasksetBenchmarkBindingSchema,
  TasksetPreferenceComparisonBindingSchema,
  TasksetSourceRefSchema,
  TaskPolicyBoundarySchema,
  TasksetEnvironmentContractSchema,
  TasksetCapabilityManifestSchema,
  TaskDataRecordSchema,
  GraderSpecSchema,
  GraderFixtureSchema,
  LearningSignalInventorySchema,
  type TasksetSourceRef, type TrainingSourceRef,
} from "./taskset-draft-core.js";

const IdSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().trim().min(1);
const HashSchema = z.string().trim().min(8).max(256);
const MetadataSchema = z.record(z.string(), z.unknown()).default({});
const NullableIdSchema = IdSchema.nullable();

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

export const GeneratedTaskFileSchema = z.object({
  path: z.string().trim().min(1).max(1_000),
  role: z.enum(["environment", "verifier", "fixture"]),
  content: z.string().max(250_000),
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

export const TasksetReadinessFindingSchema = z.object({
  code: IdSchema,
  message: z.string().trim().min(1).max(5_000),
  path: z.string().trim().max(2_000).nullable(),
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
  blockers: z.array(TasksetReadinessFindingSchema).default([]),
  advisories: z.array(TasksetReadinessFindingSchema).default([]),
  warnings: z.array(z.string().trim().min(1).max(5_000)).default([]),
  generatedAt: TimestampSchema,
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
  // Portable tasks may carry all instructions in their individual inputs.
  // Preserve an absent package prompt; draft publication validates its objective.
  objective: z.string().trim().max(20_000),
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
  // Imported releases are inspectable before local calibration. Admission
  // requires real fixtures separately in validateTaskset.
  graderFixtures: z.array(GraderFixtureSchema).max(100_000),
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

export type DatasetBuildIntent = z.infer<typeof DatasetBuildIntentSchema>;
export type DatasetBuildSpecification = z.infer<typeof DatasetBuildSpecificationSchema>;
export type GeneratedTaskFile = z.infer<typeof GeneratedTaskFileSchema>;
export type TrainingPathRecommendation = z.infer<typeof TrainingPathRecommendationSchema>;
export type TrainingMethodReadinessReasonCode = z.infer<typeof TrainingMethodReadinessReasonCodeSchema>;
export type TrainingMethodReadiness = z.infer<typeof TrainingMethodReadinessSchema>;
export type TasksetReadinessReport = z.infer<typeof TasksetReadinessReportSchema>;
export type AuthoringProvenance = z.infer<typeof AuthoringProvenanceSchema>;
export type AuthoringRepair = z.infer<typeof AuthoringRepairSchema>;
export type Taskset = z.infer<typeof TasksetSchema>;

export function isTrainingSourceRef(
  source: TasksetSourceRef,
): source is TrainingSourceRef {
  return source.schemaVersion === "openpond.trainingSource.v1";
}
