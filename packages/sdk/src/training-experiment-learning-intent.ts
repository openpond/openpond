import { z } from "zod";
import { LearningRevisionRefSchema } from "@openpond/evals/learning";

/** Incomplete authoring values may be saved before datasets are selected. */
export const TrainingExperimentLearningIntentSchema = z.object({
  enabled: z.boolean(),
  /** Applies only after an accepted compatible GRPO checkpoint exists. */
  continuationAdapterMode: z.enum(["shared", "residual_append", "sequential_merge"]).optional(),
  graders: z.array(LearningRevisionRefSchema).max(100).optional(),
  mode: z.enum(["nightly", "approved_count"]),
  minimumTasks: z.string().max(100),
  localTime: z.string().max(100),
  timeZone: z.string().max(200),
  maximumSpendUsd: z.string().max(100),
  maximumDailySpendUsd: z.string().max(100),
}).strict();
export type TrainingExperimentLearningIntent = z.infer<typeof TrainingExperimentLearningIntentSchema>;
