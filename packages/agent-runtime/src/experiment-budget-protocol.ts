import { z } from "zod";

const id = z.string().trim().min(1).max(191);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const cents = z.number().int().nonnegative().safe();
const seconds = z.number().int().nonnegative().safe();

/** The envelope's requestId is stable for every mutation. The authenticated
 * server supplies ownership; no owner/team/workspace claim is accepted here. */
export const ExperimentBudgetActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reserve"), experimentId: id, allocationId: id,
    kind: z.enum(["model", "runpod", "serving"]), requestHash: hash,
    maxCents: cents.positive(), maxSeconds: seconds }).strict(),
  z.object({ action: z.literal("dispatch"), experimentId: id, allocationId: id }).strict(),
  z.object({ action: z.literal("release_before_dispatch"), experimentId: id, allocationId: id }).strict(),
  z.object({ action: z.literal("report"), experimentId: id }).strict(),
]);
export type ExperimentBudgetAction = z.infer<typeof ExperimentBudgetActionSchema>;

export const ExperimentBudgetAllocationSchema = z.object({
  allocationId: id,
  kind: z.enum(["model", "runpod", "serving"]),
  requestHash: hash,
  maxCents: cents.positive(),
  maxSeconds: seconds,
  status: z.enum(["reserved", "dispatched", "settled", "released"]),
  actualCents: cents.nullable(),
  actualSeconds: seconds.nullable(),
  receiptHash: hash.nullable(),
}).strict();
export type ExperimentBudgetAllocation = z.infer<typeof ExperimentBudgetAllocationSchema>;

export const ExperimentBudgetReportSchema = z.object({
  capCents: cents.positive(), committedCents: cents, remainingCents: cents,
  runpodCapSeconds: seconds.positive(), committedRunpodSeconds: seconds,
  remainingRunpodSeconds: seconds,
}).strict();
export type ExperimentBudgetReport = z.infer<typeof ExperimentBudgetReportSchema>;
