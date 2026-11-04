import { z } from "zod";
import {
  ManagedAlphaEditExecutionMetadataSchema,
  AlphaEditResultSaveRequestSchema,
} from "openpond-sdk/training";
import { HostedModelProjectSummarySchema } from "openpond-sdk/model-projects";
import { ActivationExperimentAccountSchema } from "./activation-experiment-recovery.js";

const { operationId: _operationId, ...SaveIntentFields } = AlphaEditResultSaveRequestSchema.shape;
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
export const AlphaEditModelSaveIntentSchema = z
  .object({
    account: ActivationExperimentAccountSchema,
    execution: ManagedAlphaEditExecutionMetadataSchema,
    request: SaveRequest,
  })
  .strict()
  .superRefine(({ account, execution, request }, context) => {
    if (
      account.actorId !== execution.ownerUserId ||
      account.teamId !== execution.teamId ||
      request.teamId !== account.teamId ||
      execution.method !== "alphaedit" ||
      execution.phase !== "completed" ||
      request.executionId !== execution.id
    )
      context.addIssue({
        code: "custom",
        message: "Retain the exact completed AlphaEdit result, creator and workspace.",
      });
  });
export type AlphaEditModelSaveIntent = z.infer<typeof AlphaEditModelSaveIntentSchema>;
export const AlphaEditModelSaveOptionsSchema = z
  .object({
    account: ActivationExperimentAccountSchema,
    projectId: z.string().min(1).max(240).nullable(),
    executionId: z.string().min(1).max(240),
    models: z.array(HostedModelProjectSummarySchema).max(1000),
  })
  .strict();
