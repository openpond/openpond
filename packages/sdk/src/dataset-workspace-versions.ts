import { z } from "zod";
import { TasksetSplitSchema } from "./taskset-draft-core.js";
import { DatasetWorkspacePublishSchema, DatasetWorkspaceValidationSchema } from "./dataset-workspace-contracts.js";

const indexHash = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const DatasetVersionValidationSchema = DatasetWorkspaceValidationSchema.extend({ indexHash }).strict();
export const CreateDatasetVersionSchema = DatasetWorkspacePublishSchema.extend({ indexHash }).strict();
export const DatasetVersionManifestSchema = DatasetVersionValidationSchema.extend({
  draftRevision: count.positive(),
  acceptedRows: count,
  rejectedRows: count,
  shardCount: count,
  splitCounts: z.record(TasksetSplitSchema, count),
  publishedAt: z.iso.datetime(),
}).strict();

export type DatasetVersionValidation = z.infer<typeof DatasetVersionValidationSchema>;
export type DatasetVersionManifest = z.infer<typeof DatasetVersionManifestSchema>;
