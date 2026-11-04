import { z } from "zod";

const Money = z.string().regex(/^(0|[1-9]\d*)\.\d{6}$/).max(24).refine(value =>
  /^(0|[1-9]\d*)\.\d{6}$/.test(value) && value.length <= 24 &&
  BigInt(value.replace(".", "")) <= BigInt(Number.MAX_SAFE_INTEGER));

/** Read-only account-locked totals. Available credit never grants execution authority. */
export const TrainingUsageSnapshotSchema = z.object({
  schemaVersion: z.literal("openpond.trainingUsageSnapshot.v1"), asOf: z.iso.datetime(),
  customerCapUsd: Money.nullable(), chargedUsd: Money, committedUsd: Money, outstandingUsd: Money,
  remainingCapUsd: Money.nullable(), availableCreditUsd: Money, complete: z.boolean(),
  components: z.array(z.object({ component: z.enum(["gpu", "guest", "storage", "judge"]),
    chargedUsd: Money, committedUsd: Money, outstandingUsd: Money, openOwners: z.number().int().nonnegative(),
  }).strict()).length(4).refine(values => values.every((value, index) =>
    value.component === ["gpu", "guest", "storage", "judge"][index])),
}).strict();
export type TrainingUsageSnapshot = z.infer<typeof TrainingUsageSnapshotSchema>;
