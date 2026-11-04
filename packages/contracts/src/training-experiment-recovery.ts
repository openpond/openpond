import { z } from "zod";
import {
  TrainingExperimentFormDraftSchema,
  TrainingExperimentSetupRequestSchema,
  TrainingPreparationControlSchema,
  TrainingPreparationReceiptSchema,
  canonicalJson,
  canonicalComputeSpendCap,
} from "openpond-sdk/training";

const DraftId = z.string().trim().min(1).max(240);
/** Device recovery holds only canonical public requests and editable settings.
 * It is not hosted execution authority or another copy of training examples. */
export const TrainingExperimentRecoveryIntentSchema = z
  .object({
    draftId: DraftId,
    form: TrainingExperimentFormDraftSchema,
    request: z
      .object(TrainingExperimentSetupRequestSchema.shape)
      .omit({ operationId: true })
      .strict(),
  })
  .strict()
  .superRefine(({ form, request }, context) => {
    let capMatches = !request.usageFunding && form.billingMode !== "actual_usage" &&
      (form.customerCapUsd === undefined || form.billingMode === "prepaid_only");
    if (request.usageFunding) {
      try {
        capMatches = form.billingMode !== "prepaid_only" && canonicalComputeSpendCap(form.customerCapUsd) === request.usageFunding.customerCapUsd;
      } catch {
        capMatches = false;
      }
    }
    if (
      !TrainingExperimentSetupRequestSchema.safeParse({
        ...request,
        operationId: "reviewed-intent",
      }).success
    )
      context.addIssue({
        code: "custom",
        message:
          "Retain a complete valid training preparation before journaling its review.",
      });
    const recipe = {
      ...form.recipe,
      dataset: {
        ...(form.recipe.dataset && typeof form.recipe.dataset === "object"
          ? form.recipe.dataset
          : {}),
        validationSplit: form.validationSplit,
      },
    };
    if (
      canonicalJson(form.baseModel) !== canonicalJson(request.baseModel) ||
      canonicalJson(form.parent ?? null) !==
        canonicalJson(request.parent ?? null) ||
      canonicalJson(form.batch) !== canonicalJson(request.batch) ||
      canonicalJson(form.evaluation) !==
        canonicalJson(request.settings.evaluationTasksetRef ?? null) ||
      canonicalJson(recipe) !== canonicalJson(request.settings.recipe) ||
      canonicalJson(form.gpuSelection ?? null) !==
        canonicalJson(request.gpuSelection ?? null) ||
      form.recipe.method !== request.settings.method ||
      form.name.trim() !== request.name ||
      !capMatches ||
      Number(form.budget) !== request.maximumSpendUsd
    )
      context.addIssue({
        code: "custom",
        message:
          "The retained form must match its exact reviewed training request.",
      });
  });
export const TrainingExperimentControlCommandSchema = z
  .object({
    action: z.enum(["start", "cancel"]),
    id: z.string().trim().min(1).max(191),
    control: TrainingPreparationControlSchema,
  })
  .strict();
export const TrainingExperimentControlIntentSchema = z
  .object({
    draftId: DraftId,
    method: z.enum(["sft", "grpo"]),
    preparationOperationId: z.uuid(),
    receipt: TrainingPreparationReceiptSchema,
    command: TrainingExperimentControlCommandSchema,
  })
  .strict()
  .superRefine(({ receipt, command, preparationOperationId }, context) => {
    if (
      receipt.state !== "prepared" ||
      receipt.plan.request.operationId !== preparationOperationId ||
      command.id !== receipt.plan.id ||
      command.control.teamId !== receipt.plan.request.teamId ||
      command.control.planHash !== receipt.plan.contentHash ||
      command.control.expectedRevision !== receipt.revision ||
      (command.action === "start" && command.control.usageQuoteHash !== receipt.plan.usageQuote?.contentHash) ||
      (command.action === "start" && !command.control.estimateReview) ||
      (command.action === "cancel" &&
        command.control.estimateReview !== undefined)
    )
      context.addIssue({
        code: "custom",
        message:
          "Retain the exact prepared revision and reviewed training control.",
      });
  });
export type TrainingExperimentRecoveryIntent = z.infer<
  typeof TrainingExperimentRecoveryIntentSchema
>;
export type TrainingExperimentControlIntent = z.infer<
  typeof TrainingExperimentControlIntentSchema
>;
export type TrainingExperimentControlCommand = z.infer<
  typeof TrainingExperimentControlCommandSchema
>;
