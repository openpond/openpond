import { z } from "zod";
export const RecoverableEvaluationActionSchema = z.enum([
  "advanced-refiner-start",
  "experiment-evaluation-schedule",
  "training-result-save",
  "training-steering-result-save",
  "training-engram-result-save",
  "training-model-serving-control",
  "training:prepare-draft",
  "training:control-preparation",
  "training:prepare-modification",
  "training:start-modification",
  "training:cancel-modification",
  "training:prepare-engram",
  "training:start-engram",
  "training:cancel-engram",
  "training:prepare-decision",
  "training:start-decision",
  "training:cancel-decision",
  "training-decision-result-save",
  "training-decision-score",
  "training:prepare-alphaedit",
  "training:start-alphaedit",
  "training:cancel-alphaedit",
  "training-alphaedit-result-save",
  "training:prepare-neuron-training",
  "training:start-neuron-training",
  "training:cancel-neuron-training",
  "training-neuron-training-result-save",
]);
export const EvaluationOperationRecoverySchema = z
  .object({
    id: z.uuid(),
    action: RecoverableEvaluationActionSchema,
    intentHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime(),
    reviewedIntent: z.unknown().nullable(),
    command: z.unknown().nullable(),
    phase: z.enum(["reviewed", "dispatching"]).nullable(),
    recoveryReady: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.recoveryReady !==
      (value.reviewedIntent !== null && value.command !== null && value.phase !== null)
    )
      context.addIssue({
        code: "custom",
        message: "Only the actual retained intent and command admit automatic recovery.",
      });
  });
export type EvaluationOperationRecovery = z.infer<typeof EvaluationOperationRecoverySchema>;
export const EvaluationOperationRecoveryPageSchema = z
  .object({
    items: z.array(EvaluationOperationRecoverySchema).max(100),
    nextCursor: z.uuid().nullable(),
  })
  .strict();
