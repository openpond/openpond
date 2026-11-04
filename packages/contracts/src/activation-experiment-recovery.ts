import { z } from "zod";
import {
  ManagedModificationPrepareSchema, ManagedModificationStartSchema, ManagedModificationCancelSchema,
  ManagedModificationExecutionMetadataSchema,
} from "openpond-sdk/training";

/** Original configured account, not an endpoint supplied as dispatch authority. */
export const ActivationExperimentAccountSchema = z.object({
  teamId: z.string().trim().min(1).max(240), actorId: z.string().trim().min(1).max(240),
  apiOrigin: z.url().refine(value => {
    try { return new URL(value).origin === value && /^https?:/.test(value); } catch { return false; }
  }),
}).strict();
export const ActivationExperimentPrepareIntentSchema = z.object({
  account: ActivationExperimentAccountSchema,
  draftId: z.string().trim().min(1).max(240),
  request: ManagedModificationPrepareSchema.omit({operationId: true}),
}).strict().superRefine((value, context) => {
  if (value.account.teamId !== value.request.teamId || value.request.query.teamId !== value.request.teamId)
    context.addIssue({code: "custom", message: "Retain the original account and compiled preparation workspace."});
});
export const ActivationExperimentControlIntentSchema = z.object({
  account: ActivationExperimentAccountSchema,
  draftId: z.string().trim().min(1).max(240).nullable(),
  preparationOperationId: z.string().trim().min(1).max(240).nullable(),
  execution: ManagedModificationExecutionMetadataSchema,
  request: z.discriminatedUnion("action", [ManagedModificationStartSchema.omit({operationId: true}), ManagedModificationCancelSchema.omit({operationId: true})]),
}).strict().superRefine(({account, draftId, preparationOperationId, execution, request}, context) => {
  if (preparationOperationId === null && draftId !== null || account.teamId !== execution.teamId || account.actorId !== execution.ownerUserId || request.teamId !== account.teamId
    || request.id !== execution.id || request.expectedRevision !== execution.revision || request.planHash !== execution.plan.contentHash
    || (request.action === "start" && (execution.phase !== "prepared" || request.approvedMaximumSpendUsd !== execution.plan.maximumSpendUsd)))
    context.addIssue({code: "custom", message: "Retain the exact creator, execution revision, plan and approved spending cap."});
});
export type ActivationExperimentAccount = z.infer<typeof ActivationExperimentAccountSchema>;
export type ActivationExperimentPrepareIntent = z.infer<typeof ActivationExperimentPrepareIntentSchema>;
export type ActivationExperimentControlIntent = z.infer<typeof ActivationExperimentControlIntentSchema>;
