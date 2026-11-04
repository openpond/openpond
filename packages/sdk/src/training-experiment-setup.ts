import { z } from "zod";
import { ModelProjectBaseModelSchema, ModelProjectBaseModelCandidateSchema, ModelProjectVersionedRefSchema, ModelProjectTrainingSetupSchema, ModelProjectRecipeDocumentSchema } from "./model-projects.js";
import {
  TrainingPreparationRequestSchema,
  TrainingPreparationReceiptSchema,
  parseAndVerifyTrainingPreparationReceipt,
} from "./training-preparations.js";
import { TrainingGpuSelectionSchema } from "./training-compute-selection.js";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { EvaluationExperimentDraftSchema } from "./evaluation-experiment-draft.js";
import { HostedEvaluationExperimentFormDraftSchema } from "./hosted-evaluation-experiment-draft.js";
import { ActivationExperimentFormDraftSchema } from "./activation-experiment-draft.js";
import { EngramExperimentFormDraftSchema } from "./engram-experiment-draft.js";
import { DecisionExperimentFormDraftSchema } from "./decision-experiment-draft.js";
import { AlphaEditExperimentFormDraftSchema } from "./alphaedit-experiment-draft.js";
import { NeuronTrainingExperimentFormDraftSchema } from "./neuron-training-experiment-draft.js";
import { TrainingBillingModesSchema } from "./training-usage-funding.js";
export * from "./evaluation-experiment-draft.js";
export * from "./activation-experiment-draft.js";

export const ExperimentOperationTypeSchema = z.enum(["evaluate", "sft", "grpo", "neuron_steering", "inspect_activations", "engram_adapter", "decision_model", "alphaedit", "selective_neuron_training"]);
export type ExperimentOperationType = z.infer<typeof ExperimentOperationTypeSchema>;
import { ExperimentStartingModelSchema, parseAndVerifyExperimentStartingModel } from "./experiment-starting-model.js";
export { ExperimentStartingModelSchema, parseAndVerifyExperimentStartingModel, type ExperimentStartingModel } from "./experiment-starting-model.js";
export function experimentOperationLabel(type: ExperimentOperationType): string {
  return { evaluate: "Evaluate", sft: "SFT + LoRA", grpo: "RL (GRPO) + LoRA", neuron_steering: "Neuron steering", inspect_activations: "Inspect activations", engram_adapter: "Engram memory", decision_model: "Decision model", alphaedit: "AlphaEdit", selective_neuron_training: "Neuron training" }[type];
}

/** Model-first manual training. The service owns configuration identity and
 * admission; preparing never enables a recurring policy or starts compute. */
export const TrainingExperimentSetupRequestSchema = TrainingPreparationRequestSchema
  .omit({ configuration: true, origin: true })
  .extend({
    schemaVersion: z.literal("openpond.trainingExperimentSetupRequest.v1"),
    baseModel: ModelProjectBaseModelSchema,
    settings: ModelProjectTrainingSetupSchema.omit({ baseModel: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.baseModel.revision)
      context.addIssue({ code: "custom", path: ["baseModel", "revision"], message: "Select an exact model revision." });
    if (!value.settings.recipe || !["sft", "grpo"].includes(value.settings.recipe.method))
      context.addIssue({ code: "custom", path: ["settings", "recipe"], message: "Choose a supported SFT or GRPO recipe." });
    if (value.parent && value.settings.method !== "grpo")
      context.addIssue({ code: "custom", path: ["parent"], message: "Checkpoint continuation currently requires GRPO." });
    if (value.settings.method !== value.settings.recipe?.method)
      context.addIssue({ code: "custom", path: ["settings", "method"], message: "The method must match its recipe." });
  });

export const TrainingExperimentSetupReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.trainingExperimentSetupReceipt.v1"),
  request: TrainingExperimentSetupRequestSchema,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  preparation: TrainingPreparationReceiptSchema,
}).strict();

export type TrainingExperimentSetupRequest = z.infer<typeof TrainingExperimentSetupRequestSchema>;
export type TrainingExperimentSetupReceipt = z.infer<typeof TrainingExperimentSetupReceiptSchema>;

/** Deterministic across retries, scoped to the authenticated creator. */
export async function trainingExperimentConfigurationIdentity(
  input: Pick<TrainingExperimentSetupRequest, "teamId" | "operationId">,
  creatorUserId: string,
) {
  return `experiment-${await canonicalSha256({ teamId: input.teamId, operationId: input.operationId, creatorUserId })}`;
}

export async function parseAndVerifyTrainingExperimentSetupReceipt(raw: unknown) {
  const result = TrainingExperimentSetupReceiptSchema.parse(raw);
  const preparation = await parseAndVerifyTrainingPreparationReceipt(result.preparation);
  const { schemaVersion: _schema, baseModel: _base, settings: _settings, ...run } = result.request;
  const { schemaVersion: _preparedSchema, configuration, ...preparedRun } = preparation.plan.request;
  const portableId = await trainingExperimentConfigurationIdentity(result.request, preparation.plan.creatorUserId);
  if (
    result.requestHash !== await canonicalSha256(result.request) ||
    await canonicalSha256(run) !== await canonicalSha256(preparedRun) ||
    preparation.plan.source.modelProject.portableProjectId !== portableId ||
    preparation.plan.source.modelProject.revision !== configuration.expectedRevision ||
    preparation.plan.source.modelProject.contentHash !== configuration.expectedEtag
  ) throw new OpenPondProtocolError("training_experiment_setup_mismatch", "The prepared experiment does not match its reviewed draft.");
  return { ...result, preparation };
}

export function createTrainingExperimentSetupClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async prepareExperiment(input: TrainingExperimentSetupRequest): Promise<TrainingExperimentSetupReceipt> {
      const parsed = TrainingExperimentSetupRequestSchema.parse(input);
      const result = await parseAndVerifyTrainingExperimentSetupReceipt(await request("/v1/training/preparations/from-draft", {
        method: "POST", body: JSON.stringify(parsed),
      }));
      if (result.requestHash !== await canonicalSha256(parsed))
        throw new OpenPondProtocolError("training_experiment_setup_request_mismatch", "The service returned a different experiment draft.");
      return result;
    },
  };
}

/** Credential-free picker metadata, composed from existing model/learning reads.
 * Batch examples and credentials stay with their canonical owners. */
export const TrainingExperimentInputsPageSchema = z.object({
  schemaVersion: z.literal("openpond.trainingExperimentInputsPage.v1"),
  teamId: z.string().min(1).max(500), actorId: z.string().min(1).max(500), projectId: z.string().min(1).max(500).nullable(),
  models: z.array(ModelProjectBaseModelCandidateSchema).max(1000),
  methods: z.array(z.string().min(1).max(200)).max(100),
  billingModes: TrainingBillingModesSchema.optional(),
  batches: z.array(z.object({
    reference: ModelProjectVersionedRefSchema,
    rewardBinding: ModelProjectVersionedRefSchema,
    purpose: z.enum(["supervised_training", "reward_training", "evaluation"]),
    exampleCount: z.number().int().positive(), sealedAt: z.iso.datetime(),
  }).strict()).max(100),
  nextCursor: z.string().min(1).max(500).nullable(),
}).strict();
export type TrainingExperimentInputsPage = z.infer<typeof TrainingExperimentInputsPageSchema>;

/** Editable values stay separate from admitted requests so blank/invalid fields
 * can be saved without inventing a valid spend cap or input binding. */
export const TrainingExperimentFormDraftSchema = z.object({
  baseModel: ModelProjectBaseModelSchema.nullable(),
  recipe: ModelProjectRecipeDocumentSchema,
  batch: ModelProjectVersionedRefSchema.nullable(),
  evaluation: ModelProjectVersionedRefSchema.nullable(),
  validationSplit: z.enum(["validation", "frozen_eval"]),
  name: z.string().max(500),
  budget: z.string().max(100),
  customerCapUsd: z.string().max(100).optional(),
  billingMode: z.enum(["prepaid_only", "actual_usage"]).optional(),
  gpuSelection: TrainingGpuSelectionSchema.optional(),
  parent: TrainingPreparationRequestSchema.shape.parent,
  startingModelLabel: z.string().trim().min(1).max(500).optional(),
}).strict();
export type TrainingExperimentFormDraft = z.infer<typeof TrainingExperimentFormDraftSchema>;

/** An authoring snapshot may be incomplete. It is never a preparation, an
 * execution, or evidence that a model/method is available to this account. */
export const ExperimentDraftSchema = z.object({
  schemaVersion: z.literal("openpond.experimentDraft.v1"),
  id: z.string().trim().min(1).max(240),
  operationType: ExperimentOperationTypeSchema,
  name: z.string().trim().min(1).max(500),
  startingModel: ExperimentStartingModelSchema.optional(),
  evaluationForm: EvaluationExperimentDraftSchema.optional(),
  hostedEvaluationForm: HostedEvaluationExperimentFormDraftSchema.optional(),
  trainingForm: TrainingExperimentFormDraftSchema.optional(),
  activationForm: ActivationExperimentFormDraftSchema.optional(),
  engramForm: EngramExperimentFormDraftSchema.optional(),
  decisionForm: DecisionExperimentFormDraftSchema.optional(),
  alphaEditForm: AlphaEditExperimentFormDraftSchema.optional(),
  neuronTrainingForm: NeuronTrainingExperimentFormDraftSchema.optional(),
  training: z.object({
    baseModel: TrainingExperimentSetupRequestSchema.shape.baseModel.optional(),
    settings: TrainingExperimentSetupRequestSchema.shape.settings.optional(),
    batch: TrainingExperimentSetupRequestSchema.shape.batch.optional(),
    maximumSpendUsd: TrainingExperimentSetupRequestSchema.shape.maximumSpendUsd.optional(),
    usageFunding: TrainingExperimentSetupRequestSchema.shape.usageFunding,
  }).strict().optional(),
}).strict().superRefine((draft, context) => {
  const source = draft.startingModel;
  if (draft.alphaEditForm && draft.operationType !== "alphaedit")
    context.addIssue({code: "custom", path: ["alphaEditForm"], message: "AlphaEdit settings require an AlphaEdit experiment."});
  if (draft.neuronTrainingForm && draft.operationType !== "selective_neuron_training")
    context.addIssue({code: "custom", path: ["neuronTrainingForm"], message: "Neuron training settings require a neuron-training experiment."});
  if (draft.operationType === "alphaedit" && source) {
    if (source.source !== "managed" && source.source !== "alphaedit")
      context.addIssue({code: "custom", path: ["startingModel"], message: "AlphaEdit requires its exact managed base or saved AlphaEdit parent."});
    else if (draft.alphaEditForm?.baseModel && canonicalJson(source.baseModel) !== canonicalJson(draft.alphaEditForm.baseModel))
      context.addIssue({code: "custom", path: ["alphaEditForm", "baseModel"], message: "Retain the exact selected AlphaEdit source."});
  }
  if (source?.source === "alphaedit") {
    if (draft.operationType !== "alphaedit" || !draft.alphaEditForm
      || canonicalJson(draft.alphaEditForm.baseModel) !== canonicalJson(source.baseModel)
      || canonicalJson(draft.alphaEditForm.startingModule ?? null) !== canonicalJson(source.alphaedit)
      || canonicalJson(draft.alphaEditForm.parentArtifact) !== canonicalJson(source.alphaedit.artifact))
      context.addIssue({code: "custom", path: ["alphaEditForm"], message: "Retain the exact AlphaEdit matrix patch and continuation state."});
  } else if (draft.alphaEditForm?.startingModule) {
    context.addIssue({code: "custom", path: ["startingModel"], message: "Retain the saved AlphaEdit Model rather than substituting its original base."});
  }
  if (draft.operationType === "selective_neuron_training" && source) {
    if (source.source !== "managed")
      context.addIssue({code: "custom", path: ["startingModel"], message: "Neuron training currently starts from its exact managed base; learned patches are not reset or silently discarded."});
    else if (draft.neuronTrainingForm?.baseModel && canonicalJson(source.baseModel) !== canonicalJson(draft.neuronTrainingForm.baseModel))
      context.addIssue({code: "custom", path: ["neuronTrainingForm", "baseModel"], message: "Retain the selected exact neuron-training base."});
  }
  if (source?.source === "neuron_training")
    context.addIssue({code: "custom", path: ["startingModel"], message: "This neuron patch supports saved serving, but experiment continuation/composition is not supported. Explicitly select a compatible base to start a fresh experiment."});
  if (draft.decisionForm && draft.operationType !== "decision_model")
    context.addIssue({code: "custom", path: ["decisionForm"], message: "Decision settings require a decision-model experiment."});
  if (draft.operationType === "decision_model" && source) {
    if (source.source !== "managed" && source.source !== "decision")
      context.addIssue({code: "custom", path: ["startingModel"], message: "Decision training/scoring requires its exact source release or saved decision Model; another learned model is not replaced with its base."});
    else if (draft.decisionForm?.baseModel && canonicalJson(source.baseModel) !== canonicalJson(draft.decisionForm.baseModel))
      context.addIssue({code: "custom", path: ["decisionForm", "baseModel"], message: "Retain the selected exact decision source release."});
  }
  if (source?.source === "decision") {
    if (draft.operationType !== "decision_model" || !draft.decisionForm
      || canonicalJson(draft.decisionForm.baseModel) !== canonicalJson(source.baseModel)
      || canonicalJson(draft.decisionForm.startingDecision ?? null) !== canonicalJson(source.decision)
      || canonicalJson(draft.decisionForm.parentArtifact) !== canonicalJson(source.decision.artifact))
      context.addIssue({code: "custom", path: ["decisionForm"], message: "Retain the exact saved decision version and artifact for training or scoring."});
  } else if (draft.decisionForm?.startingDecision) {
    context.addIssue({code: "custom", path: ["startingModel"], message: "Retain the saved decision starting model instead of substituting its source release."});
  }
  if (draft.engramForm && draft.operationType !== "engram_adapter")
    context.addIssue({code: "custom", path: ["engramForm"], message: "Engram settings require an Engram experiment."});
  if (draft.operationType === "engram_adapter" && source) {
    if (source.source !== "managed" && source.source !== "engram")
      context.addIssue({code: "custom", path: ["startingModel"], message: "This Engram implementation requires its exact compatible managed base; saved interventions are not silently replaced with their base."});
    else if (draft.engramForm?.baseModel && canonicalJson(source.baseModel) !== canonicalJson(draft.engramForm.baseModel))
      context.addIssue({code: "custom", path: ["engramForm", "baseModel"], message: "Retain the selected exact Engram base."});
  }
  if (source?.source === "engram" && (draft.operationType !== "engram_adapter" || !draft.engramForm
    || canonicalJson(draft.engramForm.baseModel) !== canonicalJson(source.baseModel)
    || canonicalJson(draft.engramForm.startingModule ?? null) !== canonicalJson(source.engram)
    || canonicalJson(draft.engramForm.parentArtifact) !== canonicalJson(source.engram.artifact)))
    context.addIssue({code: "custom", path: ["engramForm"], message: "Retain the exact saved Engram module as the continuation parent."});
  if (source?.source === "steering") {
    if (draft.operationType !== "neuron_steering")
      context.addIssue({code: "custom", path: ["operationType"], message: "Saved steering sources currently require a neuron steering experiment."});
    if (!draft.activationForm || canonicalJson(draft.activationForm.baseModel) !== canonicalJson(source.baseModel) ||
        canonicalJson(draft.activationForm.startingProfile ?? null) !== canonicalJson(source.steering))
      context.addIssue({code: "custom", path: ["activationForm"], message: "Retain the exact saved steering source and base in the activation form."});
  } else if (draft.activationForm?.startingProfile) {
    context.addIssue({code: "custom", path: ["startingModel"], message: "Retain the saved steering starting model instead of substituting its base."});
  }
  if (source?.source === "trained") {
    const version = source.trainedVersion;
    for (const [key, base] of [["trainingForm", draft.trainingForm?.baseModel], ["training", draft.training?.baseModel], ["activationForm", draft.activationForm?.baseModel]] as const)
      if (base && canonicalJson(base) !== canonicalJson(version.request.baseModel))
        context.addIssue({code: "custom", path: [key, "baseModel"], message: "The form differs from the retained trained source's base."});
    const parent = draft.trainingForm?.parent;
    if (parent && (parent.jobId !== version.jobId || parent.checkpointId !== version.candidate.checkpointId ||
        canonicalJson(parent.artifact) !== canonicalJson(version.candidate.artifact)))
      context.addIssue({code: "custom", path: ["trainingForm", "parent"], message: "Retain the exact trained Job, artifact and checkpoint."});
  }

  if (draft.evaluationForm && draft.operationType !== "evaluate")
    context.addIssue({ code: "custom", path: ["evaluationForm"], message: "Evaluation form settings require an evaluation experiment." });
  if (draft.activationForm && !["neuron_steering", "inspect_activations"].includes(draft.operationType))
    context.addIssue({ code: "custom", path: ["activationForm"], message: "Activation settings require a steering or inspection experiment." });
  if (draft.trainingForm && (!["sft", "grpo"].includes(draft.operationType) || draft.trainingForm.recipe.method !== draft.operationType))
    context.addIssue({ code: "custom", path: ["trainingForm"], message: "Training form settings must match the experiment type." });
  if (draft.training && (!["sft", "grpo"].includes(draft.operationType) ||
      draft.training.settings && draft.training.settings.method !== draft.operationType))
    context.addIssue({ code: "custom", path: ["training"], message: "Training settings must match the experiment type." });
});
export type ExperimentDraft = z.infer<typeof ExperimentDraftSchema>;
/** Nested saved evidence is verified independently of an outer draft hash. */
export async function parseAndVerifyExperimentDraft(raw: unknown, expected: Parameters<typeof parseAndVerifyExperimentStartingModel>[1] = {}): Promise<ExperimentDraft> {
  const draft = ExperimentDraftSchema.parse(raw);
  if (draft.startingModel) await parseAndVerifyExperimentStartingModel(draft.startingModel, expected);
  return draft;
}


export const ExperimentDraftUpdateSchema = z.object({
  schemaVersion: z.literal("openpond.experimentDraftUpdate.v1"),
  operationId: z.string().trim().min(1).max(240),
  expectedRevision: z.number().int().positive(),
  draft: ExperimentDraftSchema,
}).strict();
export type ExperimentDraftUpdate = z.infer<typeof ExperimentDraftUpdateSchema>;
