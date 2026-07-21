import { z } from "zod";
import { DatasetSplitSchema } from "./dataset-artifacts.js";

const IdSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().trim().min(1);
const HashSchema = z.string().trim().min(8).max(256);
const MetadataSchema = z.record(z.string(), z.unknown()).default({});

export const DatasetImportStatusSchema = z.enum([
  "created",
  "inspecting",
  "awaiting_source_review",
  "awaiting_mapping",
  "awaiting_materialization_approval",
  "materializing",
  "validating",
  "ready",
  "cancelling",
  "cancelled",
  "failed",
]);

export const HuggingFaceDatasetLocatorSchema = z.object({
  schemaVersion: z.literal("openpond.huggingFaceDatasetLocator.v1"),
  repositoryId: z.string().trim().regex(/^[^/\s]+\/[^/\s]+$/).max(500),
  repositoryUrl: z.string().url().max(2_000),
  requestedRevision: z.string().trim().min(1).max(256).nullable(),
});

export const DatasetSourceColumnSchema = z.object({
  path: z.string().trim().min(1).max(1_000),
  logicalType: z.string().trim().min(1).max(500),
  nullable: z.boolean(),
  sampleValues: z.array(z.unknown()).max(5),
});

export const DatasetSourceSplitSchema = z.object({
  configuration: z.string().trim().min(1).max(500),
  split: z.string().trim().min(1).max(500),
  rowCount: z.number().int().nonnegative().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
});

export const HuggingFaceDatasetInspectionSchema = z.object({
  schemaVersion: z.literal("openpond.huggingFaceDatasetInspection.v1"),
  id: IdSchema,
  locator: HuggingFaceDatasetLocatorSchema,
  resolvedRevision: z.string().trim().min(7).max(256),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(20_000).nullable(),
  declaredLicense: z.string().trim().min(1).max(500).nullable(),
  gated: z.boolean(),
  private: z.boolean(),
  configurations: z.array(z.string().trim().min(1).max(500)).min(1).max(1_000),
  splits: z.array(DatasetSourceSplitSchema).min(1).max(10_000),
  columns: z.array(DatasetSourceColumnSchema).min(1).max(10_000),
  previewRows: z.array(z.record(z.string(), z.unknown())).max(25),
  sourceFiles: z.array(z.object({
    path: z.string().trim().min(1).max(2_000),
    configuration: z.string().trim().min(1).max(500),
    split: z.string().trim().min(1).max(500),
    revision: z.string().trim().min(7).max(256),
    sizeBytes: z.number().int().nonnegative().nullable(),
    contentHash: HashSchema.nullable(),
  })).max(100_000),
  inspectedAt: TimestampSchema,
  metadata: MetadataSchema,
});

export const DatasetMappingTargetSchema = z.enum([
  "row_id",
  "cluster_id",
  "prompt",
  "messages",
  "demonstration",
  "chosen",
  "rejected",
  "expected_output",
  "privileged_context",
  "reward",
  "feedback",
  "tag",
  "metadata",
]);

export const DatasetFieldBindingSchema = z.object({
  sourcePath: z.string().trim().min(1).max(1_000),
  target: DatasetMappingTargetSchema,
  transform: z.enum([
    "identity",
    "string",
    "json",
    "messages",
    "numeric",
    "math_final_answer",
  ]),
  policy: z.enum(["visible", "privileged", "metadata"]),
  required: z.boolean(),
});

export const DatasetImportMappingSchema = z.object({
  schemaVersion: z.literal("openpond.datasetImportMapping.v1"),
  sourceSchemaHash: HashSchema,
  configuration: z.string().trim().min(1).max(500),
  upstreamSplits: z.array(z.string().trim().min(1).max(500)).min(1).max(1_000),
  preset: z.enum([
    "prompt_only",
    "prompt_completion",
    "messages",
    "preference",
    "prompt_expected_answer",
    "prompt_privileged_solution",
    "prompt_feedback",
  ]),
  bindings: z.array(DatasetFieldBindingSchema).min(1).max(10_000),
  nullPolicy: z.enum(["reject", "drop", "preserve"]),
  invalidRowPolicy: z.enum(["reject_import", "drop_with_receipt"]),
  splitPolicy: z.object({
    seed: z.number().int(),
    assignments: z.record(z.string(), DatasetSplitSchema),
    validationPercent: z.number().min(0).max(100),
    frozenEvalPercent: z.number().min(0).max(100),
  }),
  importerVersion: z.string().trim().min(1).max(200),
  mappingHash: HashSchema,
});

export const DatasetImportProgressSchema = z.object({
  phase: z.enum([
    "idle",
    "metadata",
    "download",
    "mapping",
    "parquet_write",
    "verification",
    "publish",
  ]),
  completedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().nullable(),
  completedRows: z.number().int().nonnegative(),
  totalRows: z.number().int().nonnegative().nullable(),
  message: z.string().trim().min(1).max(2_000).nullable(),
});

export const DatasetImportJobSchema = z.object({
  schemaVersion: z.literal("openpond.datasetImportJob.v1"),
  id: IdSchema,
  profileId: IdSchema,
  sourceKind: z.enum(["huggingface", "uploaded_file"]),
  status: DatasetImportStatusSchema,
  locator: HuggingFaceDatasetLocatorSchema.nullable(),
  inspection: HuggingFaceDatasetInspectionSchema.nullable(),
  mapping: DatasetImportMappingSchema.nullable(),
  progress: DatasetImportProgressSchema,
  targetStorageRoot: z.string().trim().min(1).max(4_000).nullable(),
  tasksetId: IdSchema.nullable(),
  tasksetRevision: z.number().int().positive().nullable(),
  artifactId: IdSchema.nullable(),
  error: z.string().trim().min(1).max(20_000).nullable(),
  cancellationRequested: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
  metadata: MetadataSchema,
});

export const CreateHuggingFaceDatasetImportRequestSchema = z.object({
  profileId: IdSchema,
  url: z.string().trim().min(1).max(2_000),
});

export const ApproveDatasetImportMappingRequestSchema = z.object({
  name: z.string().trim().min(1).max(500),
  objective: z.string().trim().min(1).max(20_000),
  mapping: DatasetImportMappingSchema,
  targetStorageRoot: z.string().trim().min(1).max(4_000).nullable(),
  licenseApproved: z.boolean().default(false),
});

export type DatasetImportStatus = z.infer<typeof DatasetImportStatusSchema>;
export type HuggingFaceDatasetLocator = z.infer<
  typeof HuggingFaceDatasetLocatorSchema
>;
export type DatasetSourceColumn = z.infer<typeof DatasetSourceColumnSchema>;
export type DatasetSourceSplit = z.infer<typeof DatasetSourceSplitSchema>;
export type HuggingFaceDatasetInspection = z.infer<
  typeof HuggingFaceDatasetInspectionSchema
>;
export type DatasetMappingTarget = z.infer<typeof DatasetMappingTargetSchema>;
export type DatasetFieldBinding = z.infer<typeof DatasetFieldBindingSchema>;
export type DatasetImportMapping = z.infer<typeof DatasetImportMappingSchema>;
export type DatasetImportProgress = z.infer<typeof DatasetImportProgressSchema>;
export type DatasetImportJob = z.infer<typeof DatasetImportJobSchema>;
export type CreateHuggingFaceDatasetImportRequest = z.infer<
  typeof CreateHuggingFaceDatasetImportRequestSchema
>;
export type ApproveDatasetImportMappingRequest = z.infer<
  typeof ApproveDatasetImportMappingRequestSchema
>;
