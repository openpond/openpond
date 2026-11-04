import { z } from "zod";
import {
  ManagedAlphaEditPrepareSchema,
  ManagedAlphaEditStartSchema,
  ManagedAlphaEditCancelSchema,
  ManagedAlphaEditExecutionMetadataSchema,
} from "openpond-sdk/training";

import { ActivationExperimentAccountSchema } from "./activation-experiment-recovery.js";

export const AlphaEditExperimentPrepareIntentSchema = z
  .object({
    account: ActivationExperimentAccountSchema,
    draftId: z.string().trim().min(1).max(240),
    request: ManagedAlphaEditPrepareSchema.omit({ operationId: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.account.teamId !== value.request.teamId ||
      value.request.query.teamId !== value.request.teamId
    )
      context.addIssue({
        code: "custom",
        message: "Retain the original account and compiled preparation workspace.",
      });
  });
export const AlphaEditExperimentControlIntentSchema = z
  .object({
    account: ActivationExperimentAccountSchema,
    draftId: z.string().trim().min(1).max(240).nullable(),
    preparationOperationId: z.string().trim().min(1).max(240).nullable(),
    execution: ManagedAlphaEditExecutionMetadataSchema,
    request: z.discriminatedUnion("action", [
      ManagedAlphaEditStartSchema.omit({ operationId: true }),
      ManagedAlphaEditCancelSchema.omit({ operationId: true }),
    ]),
  })
  .strict()
  .superRefine(({ account, draftId, preparationOperationId, execution, request }, context) => {
    if (
      (preparationOperationId === null && draftId !== null) ||
      account.teamId !== execution.teamId ||
      account.actorId !== execution.ownerUserId ||
      request.teamId !== account.teamId ||
      request.id !== execution.id ||
      request.expectedRevision !== execution.revision ||
      request.planHash !== execution.plan.contentHash ||
      (request.action === "start" &&
        (execution.phase !== "prepared" ||
          request.approvedMaximumSpendUsd !== execution.plan.maximumSpendUsd))
    )
      context.addIssue({
        code: "custom",
        message: "Retain the exact creator, execution revision, plan and approved spending cap.",
      });
  });
export type AlphaEditExperimentPrepareIntent = z.infer<
  typeof AlphaEditExperimentPrepareIntentSchema
>;
export type AlphaEditExperimentControlIntent = z.infer<
  typeof AlphaEditExperimentControlIntentSchema
>;
