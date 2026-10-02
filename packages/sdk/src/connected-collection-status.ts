import { z } from "zod";

const Id = z.string().min(1).max(500);
const Count = z.number().int().nonnegative();

/** Hosted collection health is server reconciliation, never a local heartbeat. */
export const ConnectedCollectionStatusSchema = z.object({
  teamId: Id,
  ownerUserId: Id,
  projectId: Id.nullable(),
  status: z.enum(["active", "paused", "archived"]),
  revision: Count,
  state: z.enum(["collecting", "pending", "attention", "paused", "archived"]),
  lastReconciledAt: z.string().datetime().nullable(),
  lastCapturedAt: z.string().datetime().nullable(),
  historyDays: z.number().int().positive(),
  sources: Count,
  tasks: Count,
  datasets: z.array(z.object({
    datasetId: Id,
    projection: z.enum(["turn", "conversation"]),
    revision: Count,
  }).strict()).max(2),
  latestBatch: z.object({
    operationId: Id,
    updatedAt: z.string().datetime(),
    scanned: Count,
    captured: Count,
    unchanged: Count,
    pending: Count,
    failed: Count,
    excluded: Count,
    paused: Count,
    hasMore: z.boolean(),
  }).strict().nullable(),
}).strict();

export type ConnectedCollectionStatus = z.infer<typeof ConnectedCollectionStatusSchema>;
