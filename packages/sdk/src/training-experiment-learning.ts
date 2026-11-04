import { z } from "zod";
import { ModelInitialLearningSchema } from "./model-learning-intent.js";
import { HostedModelProjectSummarySchema, ModelProjectTrainingSetupSchema } from "./model-projects.js";
import { TrainingPreparationRequestSchema } from "./training-preparations.js";
import { LearningRevisionRefSchema } from "@openpond/evals/learning";
import { TrainingExperimentFormDraftSchema, type TrainingExperimentFormDraft } from "./training-experiment-setup.js";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";
export * from "./training-experiment-learning-intent.js";

/** An explicit policy save is separate from manual preparation and execution. */
export const TrainingExperimentLearningRequestSchema = z.object({
  schemaVersion: z.literal("openpond.trainingExperimentLearning.v1"),
  teamId: z.string().min(1).max(191),
  projectId: z.string().min(1).max(191).nullable(),
  draftId: z.string().min(1).max(191),
  form: TrainingExperimentFormDraftSchema.omit({ learningConfiguration: true }),
  expectedConfiguration: TrainingPreparationRequestSchema.shape.configuration.optional(),
  expectedPolicy: LearningRevisionRefSchema.optional(),
}).strict();
export type TrainingExperimentLearningRequest = z.infer<typeof TrainingExperimentLearningRequestSchema>;
export const TrainingExperimentLearningReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.trainingExperimentLearningReceipt.v1"),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  configuration: HostedModelProjectSummarySchema,
  policy: LearningRevisionRefSchema,
}).strict();
export type TrainingExperimentLearningReceipt = z.infer<typeof TrainingExperimentLearningReceiptSchema>;

export function trainingExperimentLearningRequest(input: {
  teamId: string; projectId: string | null; draftId: string; form: TrainingExperimentFormDraft;
}) {
  const { learningConfiguration, ...form } = input.form;
  const saved = learningConfiguration?.configuration;
  return TrainingExperimentLearningRequestSchema.parse({
    schemaVersion: "openpond.trainingExperimentLearning.v1", ...input, form,
    ...(saved ? { expectedConfiguration: { id: saved.id, expectedRevision: saved.revision, expectedEtag: saved.etag }, expectedPolicy: learningConfiguration!.policy } : {}),
  });
}
export async function trainingExperimentLearningInputHash(input: TrainingExperimentLearningRequest) {
  const value = TrainingExperimentLearningRequestSchema.parse(input);
  const { baseModel, recipe, batch, evaluation, validationSplit, learningIntent } = value.form;
  return canonicalSha256({ teamId: value.teamId, projectId: value.projectId, draftId: value.draftId,
    baseModel, recipe, batch, evaluation, validationSplit, learningIntent });
}
/** Only a training save accepts these authoring inputs. Pausing a policy keeps
 * this binding unchanged even when its current draft has unsaved edits. */
export async function trainingExperimentTrainingInputHash(form: TrainingExperimentFormDraft) {
  const { baseModel, recipe, batch, evaluation, validationSplit } = form;
  return canonicalSha256({ baseModel, recipe, batch, evaluation, validationSplit });
}
export async function trainingExperimentSavedConfiguration(form: TrainingExperimentFormDraft) {
  const saved = form.learningConfiguration;
  if (saved && saved.trainingInputHash !== await trainingExperimentTrainingInputHash(form))
    throw new Error("Save the changed training inputs before preparing this Model, or restore its accepted settings.");
  return saved;
}
export function trainingExperimentInitialLearning(input: TrainingExperimentLearningRequest) {
  const value = input.form.learningIntent;
  if (!value || (!value.enabled && !input.expectedPolicy)) throw new Error("Enable continual learning before saving its first policy.");
  return ModelInitialLearningSchema.parse({
    mode: value.mode, minimumTasks: Number(value.minimumTasks), localTime: value.localTime, timeZone: value.timeZone,
    maximumSpendUsd: Number(value.maximumSpendUsd), maximumDailySpendUsd: Number(value.maximumDailySpendUsd),
  });
}
export function trainingExperimentLearningSettings(form: TrainingExperimentFormDraft) {
  return ModelProjectTrainingSetupSchema.parse({
    method: form.recipe.method, baseModel: form.baseModel,
    recipe: { ...form.recipe, dataset: { ...(form.recipe.dataset && typeof form.recipe.dataset === "object" ? form.recipe.dataset : {}), validationSplit: form.validationSplit } },
    evaluationTasksetRef: form.evaluation, managedRolloutPlacement: "remote",
  });
}
export function createTrainingExperimentLearningClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async saveExperimentLearning(input: TrainingExperimentLearningRequest) {
      const parsed = TrainingExperimentLearningRequestSchema.parse(input);
      const result = TrainingExperimentLearningReceiptSchema.parse(await request("/v1/training/preparations/from-draft/learning", { method: "POST", body: JSON.stringify(parsed) }));
      const pausing = parsed.form.learningIntent?.enabled === false && Boolean(parsed.expectedConfiguration && parsed.expectedPolicy);
      const expected = parsed.expectedConfiguration;
      const configurationMatches = pausing
        ? result.configuration.id === expected!.id && result.configuration.revision === expected!.expectedRevision && result.configuration.etag === expected!.expectedEtag
        : result.configuration.name === parsed.form.name.trim();
      if (result.inputHash !== await trainingExperimentLearningInputHash(parsed) || result.configuration.teamId !== parsed.teamId || !configurationMatches
        || (parsed.expectedPolicy && (result.policy.id !== parsed.expectedPolicy.id || result.policy.revision !== parsed.expectedPolicy.revision + 1)))
        throw new OpenPondProtocolError("training_experiment_learning_mismatch", "The saved learning policy does not match its authored inputs.");
      return result;
    },
  };
}
