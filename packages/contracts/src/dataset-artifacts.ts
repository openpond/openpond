import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().trim().min(1);
const HashSchema = z.string().trim().min(8).max(256);
const RelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine(
    (value) =>
      !value.startsWith("/")
      && !value.startsWith("\\")
      && !value.split(/[\\/]/).includes(".."),
    "Artifact paths must be relative and stay inside the Dataset.",
  );

export const DatasetSplitSchema = z.enum([
  "train",
  "validation",
  "test",
  "frozen_eval",
]);

export const DatasetSemanticFieldSchema = z.object({
  name: z.string().trim().min(1).max(500),
  semanticRole: z.enum([
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
  ]),
  logicalType: z.enum([
    "string",
    "integer",
    "float",
    "boolean",
    "json",
    "messages",
  ]),
  nullable: z.boolean(),
  policy: z.enum(["visible", "privileged", "metadata"]),
});

export const DatasetSemanticSchemaSchema = z.object({
  schemaVersion: z.literal("openpond.datasetSemanticSchema.v1"),
  fields: z.array(DatasetSemanticFieldSchema).min(1).max(10_000),
  schemaHash: HashSchema,
});

export const DatasetShardRefSchema = z.object({
  id: IdSchema,
  split: DatasetSplitSchema,
  path: RelativePathSchema,
  contentHash: HashSchema,
  schemaHash: HashSchema,
  sizeBytes: z.number().int().nonnegative(),
  rowCount: z.number().int().positive(),
  rowGroupCount: z.number().int().positive(),
});

export const DatasetArtifactManifestSchema = z.object({
  schemaVersion: z.literal("openpond.datasetArtifact.v1"),
  id: IdSchema,
  tasksetId: IdSchema,
  tasksetRevision: z.number().int().positive(),
  contentHash: HashSchema,
  format: z.literal("parquet"),
  schema: DatasetSemanticSchemaSchema,
  shards: z.array(DatasetShardRefSchema).min(1).max(100_000),
  rowCount: z.number().int().positive(),
  splitCounts: z.record(DatasetSplitSchema, z.number().int().nonnegative()),
  sourceReceiptRefs: z.array(IdSchema).min(1).max(100_000),
  mappingHash: HashSchema,
  qualityReportHash: HashSchema,
  createdAt: TimestampSchema,
});

export const DatasetArtifactSummarySchema = z.object({
  schemaVersion: z.literal("openpond.datasetArtifactSummary.v1"),
  artifactId: IdSchema,
  tasksetId: IdSchema,
  tasksetRevision: z.number().int().positive(),
  format: z.literal("parquet"),
  rowCount: z.number().int().positive(),
  splitCounts: z.record(DatasetSplitSchema, z.number().int().nonnegative()),
  sizeBytes: z.number().int().nonnegative(),
  contentHash: HashSchema,
  available: z.boolean(),
  unavailableReason: z.string().trim().min(1).max(2_000).nullable(),
  createdAt: TimestampSchema,
});

export const DatasetCatalogItemSchema = z.object({
  schemaVersion: z.literal("openpond.datasetCatalogItem.v1"),
  tasksetId: IdSchema,
  tasksetRevision: z.number().int().positive(),
  artifactId: IdSchema.nullable(),
  name: z.string().trim().min(1).max(500),
  status: z.enum([
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
  ]),
  storageKind: z.enum(["inline", "parquet"]),
  rowCount: z.number().int().nonnegative(),
  splitCounts: z.record(DatasetSplitSchema, z.number().int().nonnegative()),
  sizeBytes: z.number().int().nonnegative().nullable(),
  available: z.boolean(),
  unavailableReason: z.string().trim().min(1).max(2_000).nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const DatasetCatalogResponseSchema = z.object({
  schemaVersion: z.literal("openpond.datasetCatalog.v1"),
  profileId: IdSchema,
  datasets: z.array(DatasetCatalogItemSchema),
  generatedAt: TimestampSchema,
});

export const DatasetArtifactRegistryEntrySchema = z.object({
  schemaVersion: z.literal("openpond.datasetArtifactRegistry.v1"),
  manifest: DatasetArtifactManifestSchema,
  profileId: IdSchema,
  storageRoot: z.string().trim().min(1).max(4_000),
  relativeManifestPath: RelativePathSchema,
  available: z.boolean(),
  unavailableReason: z.string().trim().min(1).max(2_000).nullable(),
  verifiedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const DatasetRowPageRequestSchema = z.object({
  split: DatasetSplitSchema.nullable().default(null),
  cursor: z.string().trim().min(1).max(2_000).nullable().default(null),
  limit: z.number().int().min(1).max(100).default(25),
  columns: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
});

export const DatasetRowPageSchema = z.object({
  schemaVersion: z.literal("openpond.datasetRowPage.v1"),
  tasksetId: IdSchema,
  tasksetRevision: z.number().int().positive(),
  artifactHash: HashSchema,
  split: DatasetSplitSchema.nullable(),
  rows: z.array(z.record(z.string(), z.unknown())).max(100),
  nextCursor: z.string().max(2_000).nullable(),
  totalRows: z.number().int().nonnegative(),
  returnedRows: z.number().int().nonnegative(),
});

export type DatasetSplit = z.infer<typeof DatasetSplitSchema>;
export type DatasetSemanticField = z.infer<typeof DatasetSemanticFieldSchema>;
export type DatasetSemanticSchema = z.infer<typeof DatasetSemanticSchemaSchema>;
export type DatasetShardRef = z.infer<typeof DatasetShardRefSchema>;
export type DatasetArtifactManifest = z.infer<
  typeof DatasetArtifactManifestSchema
>;
export type DatasetArtifactSummary = z.infer<
  typeof DatasetArtifactSummarySchema
>;
export type DatasetCatalogItem = z.infer<typeof DatasetCatalogItemSchema>;
export type DatasetCatalogResponse = z.infer<
  typeof DatasetCatalogResponseSchema
>;
export type DatasetArtifactRegistryEntry = z.infer<
  typeof DatasetArtifactRegistryEntrySchema
>;
export type DatasetRowPageRequest = z.infer<
  typeof DatasetRowPageRequestSchema
>;
export type DatasetRowPage = z.infer<typeof DatasetRowPageSchema>;
