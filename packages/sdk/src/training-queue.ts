import { z } from "zod";

const Timestamp = z.string().datetime({ offset: true });

/** Customer status deliberately omits provider/internal capacity reasons. A
 * stable ticket identifies the request; current fair-queue position may change. */
export const TrainingQueueStatusSchema = z.object({
  ticketId: z.string().trim().min(1).max(191),
  ticketNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  label: z.literal("Waiting for resources"),
  position: z.number().int().positive().nullable(),
  positionScope: z.literal("compatible_fair_queue"),
  enqueuedAt: Timestamp,
  asOf: Timestamp,
  estimate: z.object({
    revision: z.number().int().nonnegative(),
    estimatedStartAt: Timestamp,
    expiresAt: Timestamp,
    evidence: z.enum(["observed_capacity", "measured_bootstrap", "scheduled_release"]),
  }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if (value.estimate && Date.parse(value.estimate.expiresAt) <= Date.parse(value.asOf))
    context.addIssue({ code: "custom", path: ["estimate"], message: "An expired queue forecast must be returned as unavailable" });
});

export type TrainingQueueStatus = z.infer<typeof TrainingQueueStatusSchema>;
