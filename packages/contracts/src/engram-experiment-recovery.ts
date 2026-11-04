import { z } from "zod";
import {
  ManagedEngramPrepareSchema, ManagedEngramStartSchema, ManagedEngramCancelSchema,
  ManagedEngramExecutionMetadataSchema,
} from "openpond-sdk/training";

import { ActivationExperimentAccountSchema } from "./activation-experiment-recovery.js";

export const EngramExperimentPrepareIntentSchema = z.object({
  account: ActivationExperimentAccountSchema,
  draftId: z.string().trim().min(1).max(240),
  request: ManagedEngramPrepareSchema.omit({operationId: true}),
}).strict().superRefine((value, context) => {
  if (value.account.teamId !== value.request.teamId || value.request.query.teamId !== value.request.teamId)
    context.addIssue({code: "custom", message: "Retain the original account and compiled preparation workspace."});
});
export const EngramExperimentControlIntentSchema = z.object({
  account: ActivationExperimentAccountSchema,
  draftId: z.string().trim().min(1).max(240).nullable(),
  preparationOperationId: z.string().trim().min(1).max(240).nullable(),
  execution: ManagedEngramExecutionMetadataSchema,
  request: z.discriminatedUnion("action", [ManagedEngramStartSchema.omit({operationId: true}), ManagedEngramCancelSchema.omit({operationId: true})]),
}).strict().superRefine(({account, draftId, preparationOperationId, execution, request}, context) => {
  if (preparationOperationId === null && draftId !== null || account.teamId !== execution.teamId || account.actorId !== execution.ownerUserId || request.teamId !== account.teamId
    || request.id !== execution.id || request.expectedRevision !== execution.revision || request.planHash !== execution.plan.contentHash
    || (request.action === "start" && (execution.phase !== "prepared" || request.approvedMaximumSpendUsd !== execution.plan.maximumSpendUsd)))
    context.addIssue({code: "custom", message: "Retain the exact creator, execution revision, plan and approved spending cap."});
});
export type EngramExperimentPrepareIntent = z.infer<typeof EngramExperimentPrepareIntentSchema>;
export type EngramExperimentControlIntent = z.infer<typeof EngramExperimentControlIntentSchema>;
