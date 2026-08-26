import { z } from "zod";

import { DatasetArtifactManifestSchema } from "./dataset-artifacts.js";
import {
  GraderFixtureSchema,
  GraderSpecSchema,
  LearningSignalInventorySchema,
  TaskDataRecordSchema,
  TaskPolicyBoundarySchema,
  TasksetBenchmarkBindingSchema,
  TasksetCapabilityManifestSchema,
  TasksetEnvironmentContractSchema,
  TasksetMetricPolicySchema,
  TasksetPreferenceComparisonBindingSchema,
  TasksetPurposeSchema,
  TasksetSourceRefSchema,
} from "./tasksets.js";

const IdSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().trim().min(1);
const HashSchema = z.string().trim().min(8).max(256);
const CodeIdentifierSchema = z.string().trim().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
const MetadataSchema = z.record(z.string(), z.unknown()).default({});

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

export const TaskDataDraftSchema = TaskDataRecordSchema.extend({
  sourceRefs: z.array(IdSchema).max(100).default([]),
});

export const TasksetDraftStatusSchema = z.enum([
  "draft",
  "validating",
  "needs_review",
  "published",
]);

export const TasksetDraftReviewPolicySchema = z.object({
  enabled: z.boolean(),
  candidateCount: z.number().int().min(2).max(4),
  minimumSamples: z.number().int().min(1).max(10_000).default(100),
  allowTies: z.boolean(),
  allowRejectAll: z.boolean(),
  rubric: z.string().trim().max(50_000),
  criteria: z.array(z.object({
    id: IdSchema,
    label: z.string().trim().min(1).max(500),
    description: z.string().trim().max(10_000),
    weight: z.number().nonnegative().max(1_000),
  })).max(100),
});

export const TasksetDraftOutputContractSchema = z.object({
  mode: z.enum(["text", "structured_json", "artifacts"]),
  jsonSchema: z.record(z.string(), z.unknown()).nullable(),
  renderer: z.object({
    module: z.string().trim().min(1).max(1_000)
      .refine(safeRelativeFilePath, "Renderer modules must use a safe relative path."),
    exportName: CodeIdentifierSchema,
    configRef: z.string().trim().min(1).max(1_000)
      .refine(safeRelativeFilePath, "Renderer configuration must use a safe relative path.")
      .nullable()
      .default(null),
  }).nullable(),
}).superRefine((output, context) => {
  if (output.mode === "structured_json" && !output.jsonSchema) {
    context.addIssue({
      code: "custom",
      message: "Structured JSON output requires a JSON Schema.",
      path: ["jsonSchema"],
    });
  }
  if (output.mode === "text" && output.renderer) {
    context.addIssue({
      code: "custom",
      message: "Text output cannot configure an artifact renderer.",
      path: ["renderer"],
    });
  }
});

export const TasksetDraftSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetDraft.v1"),
  id: IdSchema,
  revision: z.number().int().positive(),
  profileId: IdSchema,
  name: z.string().trim().max(500),
  objective: z.string().trim().max(20_000),
  purpose: TasksetPurposeSchema.default("general"),
  benchmark: TasksetBenchmarkBindingSchema.nullable().default(null),
  preferenceComparison: TasksetPreferenceComparisonBindingSchema.nullable().default(null),
  status: TasksetDraftStatusSchema,
  sourceRefs: z.array(TasksetSourceRefSchema).max(100_000).default([]),
  datasetArtifact: DatasetArtifactManifestSchema.nullable().optional(),
  policy: TaskPolicyBoundarySchema,
  environment: TasksetEnvironmentContractSchema,
  output: TasksetDraftOutputContractSchema.default({
    mode: "text",
    jsonSchema: null,
    renderer: null,
  }),
  capabilities: TasksetCapabilityManifestSchema,
  metrics: TasksetMetricPolicySchema,
  review: TasksetDraftReviewPolicySchema,
  tasks: z.array(TaskDataDraftSchema).max(1_000_000).default([]),
  graders: z.array(GraderSpecSchema).max(1_000).default([]),
  graderFixtures: z.array(GraderFixtureSchema).max(100_000).default([]),
  learningSignals: LearningSignalInventorySchema,
  publishedTasksetRef: z.object({
    id: IdSchema,
    revision: z.number().int().positive(),
    contentHash: HashSchema,
  }).nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  metadata: MetadataSchema,
}).superRefine((draft, context) => {
  if (draft.purpose === "benchmark" && !draft.benchmark) {
    context.addIssue({
      code: "custom",
      message: "Benchmark drafts require an immutable benchmark binding.",
      path: ["benchmark"],
    });
  }
  if (draft.purpose !== "benchmark" && draft.benchmark) {
    context.addIssue({
      code: "custom",
      message: "Only benchmark drafts may carry a benchmark binding.",
      path: ["benchmark"],
    });
  }
  if (draft.datasetArtifact && draft.tasks.length > 0) {
    context.addIssue({
      code: "custom",
      message: "Artifact-backed drafts may not duplicate canonical rows inline.",
      path: ["tasks"],
    });
  }
  if (draft.status === "published" && !draft.publishedTasksetRef) {
    context.addIssue({
      code: "custom",
      message: "Published drafts require an immutable Taskset reference.",
      path: ["publishedTasksetRef"],
    });
  }
});

export type TaskDataDraft = z.infer<typeof TaskDataDraftSchema>;
export type TasksetDraftStatus = z.infer<typeof TasksetDraftStatusSchema>;
export type TasksetDraftReviewPolicy = z.infer<typeof TasksetDraftReviewPolicySchema>;
export type TasksetDraftOutputContract = z.infer<typeof TasksetDraftOutputContractSchema>;
export type TasksetDraft = z.infer<typeof TasksetDraftSchema>;
