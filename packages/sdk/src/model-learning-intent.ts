import { NightlyScheduleSchema } from "@openpond/evals/learning";
import { z } from "zod";

/** An explicit creation choice, committed atomically with its new Model.
 * Existing Models edit the authoritative policy through Learning commands. */
export const ModelInitialLearningSchema = NightlyScheduleSchema.extend({
  mode: z.enum(["nightly", "approved_count"]),
  minimumTasks: z.number().int().min(1).max(10_000),
  maximumSpendUsd: z.number().positive().max(100_000),
  maximumDailySpendUsd: z.number().positive().max(1_000_000),
}).strict().superRefine((value, context) => {
  if (value.maximumDailySpendUsd < value.maximumSpendUsd) context.addIssue({ code: "custom", path: ["maximumDailySpendUsd"], message: "The daily budget must cover one update." });
});
export type ModelInitialLearning = z.infer<typeof ModelInitialLearningSchema>;
