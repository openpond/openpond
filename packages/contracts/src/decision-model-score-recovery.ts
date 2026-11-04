import { z } from "zod";
import { DecisionModelScoreRequestSchema } from "openpond-sdk/training";
import { ActivationExperimentAccountSchema } from "./activation-experiment-recovery.js";

/** Retains the typed, unlabeled scoring input and exact version through the
 * existing reviewed operation journal; requestId is its original operation. */
export const DecisionModelScoreIntentSchema = z.object({
  account: ActivationExperimentAccountSchema,
  modelProjectId: z.string().trim().min(1).max(240),
  request: DecisionModelScoreRequestSchema.omit({requestId: true}),
}).strict().superRefine((value, context) => {
  if (value.account.teamId !== value.request.teamId)
    context.addIssue({code: "custom", message: "Retain the original scoring account and workspace."});
});
export const DecisionModelScoreCommandSchema = z.object({
  modelProjectId: z.string().trim().min(1).max(240), request: DecisionModelScoreRequestSchema,
}).strict();
export type DecisionModelScoreIntent = z.infer<typeof DecisionModelScoreIntentSchema>;
export type DecisionModelScoreCommand = z.infer<typeof DecisionModelScoreCommandSchema>;
