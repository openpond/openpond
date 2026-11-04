import { z } from "zod";
import {
  ManagedDecisionPrepareSchema, ManagedDecisionStartSchema, ManagedDecisionCancelSchema,
  ManagedDecisionExecutionMetadataSchema,
} from "openpond-sdk/training";

import { ActivationExperimentAccountSchema } from "./activation-experiment-recovery.js";

export const DecisionExperimentPrepareIntentSchema = z.object({
  account: ActivationExperimentAccountSchema,
  draftId: z.string().trim().min(1).max(240),
  request: ManagedDecisionPrepareSchema.omit({operationId: true}),
}).strict().superRefine((value, context) => {
  if (value.account.teamId !== value.request.teamId || value.request.query.teamId !== value.request.teamId)
    context.addIssue({code: "custom", message: "Retain the original account and compiled preparation workspace."});
});
export const DecisionExperimentControlIntentSchema = z.object({
  account: ActivationExperimentAccountSchema,
  draftId: z.string().trim().min(1).max(240).nullable(),
  preparationOperationId: z.string().trim().min(1).max(240).nullable(),
  execution: ManagedDecisionExecutionMetadataSchema,
  request: z.discriminatedUnion("action", [ManagedDecisionStartSchema.omit({operationId: true}), ManagedDecisionCancelSchema.omit({operationId: true})]),
}).strict().superRefine(({account, draftId, preparationOperationId, execution, request}, context) => {
  if (preparationOperationId === null && draftId !== null || account.teamId !== execution.teamId || account.actorId !== execution.ownerUserId || request.teamId !== account.teamId
    || request.id !== execution.id || request.expectedRevision !== execution.revision || request.planHash !== execution.plan.contentHash
    || (request.action === "start" && (execution.phase !== "prepared" || request.approvedMaximumSpendUsd !== execution.plan.maximumSpendUsd)))
    context.addIssue({code: "custom", message: "Retain the exact creator, execution revision, plan and approved spending cap."});
});
export type DecisionExperimentPrepareIntent = z.infer<typeof DecisionExperimentPrepareIntentSchema>;
export type DecisionExperimentControlIntent = z.infer<typeof DecisionExperimentControlIntentSchema>;
