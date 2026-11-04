import { z } from "zod";
import {
  ManagedDecisionExecutionMetadataSchema,
  DecisionResultSaveRequestSchema,
} from "openpond-sdk/training";
import { HostedModelProjectSummarySchema } from "openpond-sdk/model-projects";
import { ActivationExperimentAccountSchema } from "./activation-experiment-recovery.js";

const { operationId: _operationId, ...SaveIntentFields } = DecisionResultSaveRequestSchema.shape;
const SaveRequest = z
  .object(SaveIntentFields)
  .strict()
  .refine(
    (value) =>
      value.modelProjectId ? value.expectedModelRevision > 0 : value.expectedModelRevision === 0,
    { message: "Retain the exact destination Model revision, or create a new Model." },
  );

/** Only the immutable result/module pin enters the existing device journal;
 * capture bytes stay with the canonical hosted execution owner. */
export const DecisionModelSaveIntentSchema = z
  .object({
    account: ActivationExperimentAccountSchema,
    execution: ManagedDecisionExecutionMetadataSchema,
    request: SaveRequest,
  })
  .strict()
  .superRefine(({ account, execution, request }, context) => {
    if (
      account.actorId !== execution.ownerUserId ||
      account.teamId !== execution.teamId ||
      request.teamId !== account.teamId ||
      execution.method !== "decision_model" ||
      execution.phase !== "completed" ||
      execution.mode !== "train" ||
      request.executionId !== execution.id
    )
      context.addIssue({
        code: "custom",
        message: "Retain the exact completed Decision result, creator and workspace.",
      });
  });
export type DecisionModelSaveIntent = z.infer<typeof DecisionModelSaveIntentSchema>;
export const DecisionModelSaveOptionsSchema = z
  .object({
    account: ActivationExperimentAccountSchema,
    projectId: z.string().min(1).max(240).nullable(),
    executionId: z.string().min(1).max(240),
    models: z.array(HostedModelProjectSummarySchema).max(1000),
  })
  .strict();
