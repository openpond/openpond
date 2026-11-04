import { z } from "zod";

/** Incomplete authoring values may be saved before datasets are selected. */
export const TrainingExperimentLearningIntentSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["nightly", "approved_count"]),
  minimumTasks: z.string().max(100),
  localTime: z.string().max(100),
  timeZone: z.string().max(200),
  maximumSpendUsd: z.string().max(100),
  maximumDailySpendUsd: z.string().max(100),
}).strict();
export type TrainingExperimentLearningIntent = z.infer<typeof TrainingExperimentLearningIntentSchema>;
