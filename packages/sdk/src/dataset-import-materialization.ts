import { z } from "zod";
import { TasksetSplitSchema } from "./taskset-draft-core.js";

const id = z.string().min(1).max(240).regex(/^[a-zA-Z0-9._:-]+$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().min(1).max(128);
const cursor = z.string().regex(/^[1-9]\d{0,15}$/u)
  .refine(value => Number.isSafeInteger(Number(value)));

export const BeginDatasetMaterializationSchema = z.object({
  operationId: id,
  mappingRevision: revision,
  mappingHash: hash,
  allowRejectedRows: z.boolean().default(false),
}).strict();

export const DatasetMaterializationSchema = z.object({
  importId: id,
  materializationId: id,
  mappingRevision: revision,
  mappingHash: hash,
  state: z.enum(["queued", "processing", "paused", "ready", "failed"]),
  acceptedRows: count,
  rejectedRows: count,
  shardCount: count,
  splitCounts: z.record(TasksetSplitSchema, count).nullable(),
  indexHash: hash.nullable(),
  failureCode: id.nullable(),
}).strict();

export const DatasetMaterializationShardSchema = z.object({
  objectId: id,
  fileId: id,
  ordinal: count.positive(),
  split: TasksetSplitSchema,
  sha256: hash,
  sizeBytes: count.positive(),
  rowCount: count.positive(),
  rowGroupCount: count.positive(),
}).strict();

export const DatasetMaterializationPageQuerySchema = z.object({
  after: cursor.optional(),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();

export const DatasetMaterializationPageSchema = DatasetMaterializationSchema.extend({
  shards: z.array(DatasetMaterializationShardSchema).max(100),
  nextCursor: cursor.nullable(),
}).strict();

export type DatasetMaterialization = z.infer<typeof DatasetMaterializationSchema>;
export type DatasetMaterializationShard = z.infer<typeof DatasetMaterializationShardSchema>;
export type DatasetMaterializationPage = z.infer<typeof DatasetMaterializationPageSchema>;
