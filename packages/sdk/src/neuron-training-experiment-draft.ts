import { z } from "zod";
import { ModelProjectBaseModelSchema, ModelProjectVersionedRefSchema } from "./model-projects.js";
import { StoredManagedModificationResultReferenceSchema } from "./experiment-result-reference.js";
import { NeuronTrainingSelectionSchema, NeuronTrainingSettingsSchema } from "./neuron-training.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SavedNeuronTrainingExperimentSourceSchema = z.object({
  modelProjectId: Id, versionHash: Hash,
  artifact: z.object({id: Id, contentHash: Hash}).strict(), modelHash: Hash,
}).strict();
export type SavedNeuronTrainingExperimentSource = z.infer<typeof SavedNeuronTrainingExperimentSourceSchema>;
export const NEURON_TRAINING_SELECTION_DEFAULTS = NeuronTrainingSelectionSchema.parse({
  count: 8, span: "reply_prediction", backgroundStatistic: "max_domains",
  maximumBackgroundTargetRatio: 0.2, gradientExamples: 16, explicitCoordinates: null,
});
export const NEURON_TRAINING_DEFAULTS = NeuronTrainingSettingsSchema.parse({
  learningRate: 0.03, maxSteps: 32, gradientAccumulationSteps: 1, maxSequenceLength: 2048,
  preservationWeight: 0, preservationExamplesPerStep: 0, seed: 42,
  maxDurationSeconds: 3600, maxCheckpointBytes: 16_777_216, maximumForwardTokenWork: 16_000_000,
});
const Field = z.string().max(100);
export const NeuronTrainingSelectionFormDraftSchema = z.object({
  count: Field, span: NeuronTrainingSelectionSchema.shape.span,
  backgroundStatistic: NeuronTrainingSelectionSchema.shape.backgroundStatistic,
  maximumBackgroundTargetRatio: Field, gradientExamples: Field,
  /** Blank selects automatically; otherwise one layer:neuron coordinate per line. */
  coordinates: z.string().max(10_000),
}).strict();
export const NeuronTrainingSettingsFormDraftSchema = z.object({
  learningRate: Field, maxSteps: Field, gradientAccumulationSteps: Field, maxSequenceLength: Field,
  preservationWeight: Field, preservationExamplesPerStep: Field, seed: Field,
  maxDurationSeconds: Field, maxCheckpointBytes: Field, maximumForwardTokenWork: Field,
}).strict();
export const NeuronTrainingInspectionSourceSchema = z.object({
  result: StoredManagedModificationResultReferenceSchema,
  modelHash: Hash,
}).strict();
/** Selection provenance is reauthorized by the compiler; this reference grants
 * no access to a capture and cannot replace reviewed target/background data. */
export const NeuronTrainingExperimentFormDraftSchema = z.object({
  baseModel: ModelProjectBaseModelSchema.nullable(), targetBatch: ModelProjectVersionedRefSchema.nullable(),
  background: z.array(z.object({domain: z.string().max(100), batch: ModelProjectVersionedRefSchema.nullable()}).strict()).max(8),
  preservationBatch: ModelProjectVersionedRefSchema.nullable(),
  name: z.string().max(500), maximumSpendUsd: Field,
  selection: NeuronTrainingSelectionFormDraftSchema, training: NeuronTrainingSettingsFormDraftSchema,
  parentArtifact: z.null(), inspectionSource: NeuronTrainingInspectionSourceSchema.optional(),
}).strict();
export type NeuronTrainingExperimentFormDraft = z.infer<typeof NeuronTrainingExperimentFormDraftSchema>;
export function newNeuronTrainingExperimentForm(baseModel: z.infer<typeof ModelProjectBaseModelSchema> | null = null): NeuronTrainingExperimentFormDraft {
  const selection = NEURON_TRAINING_SELECTION_DEFAULTS;
  return NeuronTrainingExperimentFormDraftSchema.parse({
    baseModel, targetBatch: null, background: [{domain: "background", batch: null}], preservationBatch: null,
    name: "", maximumSpendUsd: "", parentArtifact: null,
    selection: {count: String(selection.count), span: selection.span, backgroundStatistic: selection.backgroundStatistic,
      maximumBackgroundTargetRatio: String(selection.maximumBackgroundTargetRatio), gradientExamples: String(selection.gradientExamples), coordinates: ""},
    training: Object.fromEntries(Object.entries(NEURON_TRAINING_DEFAULTS).map(([key, value]) => [key, String(value)])),
  });
}
