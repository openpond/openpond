import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().trim().min(1);
const HashSchema = z.string().trim().min(8).max(256);
const MetadataSchema = z.record(z.string(), z.unknown()).default({});
const RevisionSchema = z.string().trim().min(7).max(256);

export const DatasetSourceReviewStatusSchema = z.enum([
  "pending",
  "approved",
  "review",
  "blocked",
]);

const ExternalDatasetSourceBaseSchema = z.object({
  id: IdSchema,
  profileId: IdSchema,
  title: z.string().trim().min(1).max(500),
  sourceHash: HashSchema,
  occurredAt: TimestampSchema,
  licensingStatus: DatasetSourceReviewStatusSchema,
  secretScanStatus: z.enum(["pending", "passed", "blocked"]),
  piiScanStatus: z.enum(["pending", "passed", "review", "blocked"]),
  metadata: MetadataSchema,
});

export const HuggingFaceDatasetSourceRefSchema =
  ExternalDatasetSourceBaseSchema.extend({
    schemaVersion: z.literal("openpond.huggingFaceDatasetSource.v1"),
    kind: z.literal("huggingface"),
    repositoryId: z.string().trim().regex(/^[^/\s]+\/[^/\s]+$/).max(500),
    repositoryUrl: z.string().url().max(2_000),
    revision: RevisionSchema,
    configuration: z.string().trim().min(1).max(500),
    upstreamSplits: z.array(z.string().trim().min(1).max(500)).min(1).max(1_000),
    gated: z.boolean(),
    private: z.boolean(),
    declaredLicense: z.string().trim().min(1).max(500).nullable(),
    sourceFileHashes: z.array(HashSchema).min(1).max(100_000),
  });

export const UploadedFileDatasetSourceRefSchema =
  ExternalDatasetSourceBaseSchema.extend({
    schemaVersion: z.literal("openpond.uploadedFileDatasetSource.v1"),
    kind: z.literal("uploaded_file"),
    originalFileNames: z.array(z.string().trim().min(1).max(500)).min(1).max(1_000),
    mediaTypes: z.array(z.string().trim().min(1).max(200)).min(1).max(1_000),
    sourceFileHashes: z.array(HashSchema).min(1).max(1_000),
    totalBytes: z.number().int().nonnegative(),
    parserVersion: z.string().trim().min(1).max(200),
  });

export const GeneratedDatasetSourceRefSchema =
  ExternalDatasetSourceBaseSchema.extend({
    schemaVersion: z.literal("openpond.generatedDatasetSource.v1"),
    kind: z.literal("generated"),
    generatorId: IdSchema,
    generatorVersion: z.string().trim().min(1).max(200),
    seed: z.number().int(),
    generatorHash: HashSchema,
  });

export const ExternalDatasetSourceRefSchema = z.discriminatedUnion("kind", [
  HuggingFaceDatasetSourceRefSchema,
  UploadedFileDatasetSourceRefSchema,
  GeneratedDatasetSourceRefSchema,
]);

export type DatasetSourceReviewStatus = z.infer<
  typeof DatasetSourceReviewStatusSchema
>;
export type HuggingFaceDatasetSourceRef = z.infer<
  typeof HuggingFaceDatasetSourceRefSchema
>;
export type UploadedFileDatasetSourceRef = z.infer<
  typeof UploadedFileDatasetSourceRefSchema
>;
export type GeneratedDatasetSourceRef = z.infer<
  typeof GeneratedDatasetSourceRefSchema
>;
export type ExternalDatasetSourceRef = z.infer<
  typeof ExternalDatasetSourceRefSchema
>;
