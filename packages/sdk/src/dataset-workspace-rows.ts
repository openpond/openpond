import { z } from "zod";
import { TasksetSplitSchema } from "./taskset-draft-core.js";

const cursor = z.string().min(1).max(240).regex(/^[A-Za-z0-9_-]+$/u);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(240);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);

export const DatasetWorkspaceRowsQuerySchema = z.object({
  revision: count.positive().optional(),
  splits: z.array(TasksetSplitSchema).max(4).default([]),
  fileId: z.string().regex(/^[A-Za-z0-9._:-]{1,240}$/u).refine(value => value !== "." && value !== "..").optional(),
  cursor: cursor.optional(),
  limit: count.min(1).max(100).default(20),
}).strict();

export const DatasetWorkspaceRowsSchema = z.object({
  teamId: id,
  datasetId: id,
  revision: count.positive(),
  indexHash: hash,
  total: count,
  rows: z.array(z.object({
    id: hash,
    split: TasksetSplitSchema,
    input: z.record(z.string(), z.json()),
    policyVisibleContext: z.record(z.string(), z.json()),
    source: z.object({ fileId: id, ordinal: count.positive() }).strict(),
  }).strict()).max(100),
  nextCursor: cursor.nullable(),
}).strict();

export type DatasetWorkspaceRows = z.infer<typeof DatasetWorkspaceRowsSchema>;
