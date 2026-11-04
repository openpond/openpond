import { SavedSteeringExperimentSourceSchema, type SavedSteeringExperimentSource } from "./steering-experiment-source.js";
import { verifySavedSteeringExperimentSource } from "./steering-experiment-source-verification.js";
import { z } from "zod";
import { ModelProjectBaseModelSchema } from "./model-projects.js";
import { TrainingModelVersionSchema, parseAndVerifyTrainingModelVersion } from "./training-result.js";
import { canonicalJson, OpenPondProtocolError } from "./protocol.js";
import { canonicalSha256 } from "./protocol.js";
import { SavedEngramExperimentSourceSchema, parseAndVerifyEngramModelVersion, type SavedEngramExperimentSource } from "./engram-model-version.js";
import { SavedDecisionExperimentSourceSchema, decisionSourcePreference, type SavedDecisionExperimentSource } from "./decision-experiment-draft.js";
import { verifySavedDecisionExperimentSource } from "./decision-model-version.js";
import { SavedAlphaEditExperimentSourceSchema, type SavedAlphaEditExperimentSource } from "./alphaedit-experiment-draft.js";
import { SavedNeuronTrainingExperimentSourceSchema, type SavedNeuronTrainingExperimentSource } from "./neuron-training-experiment-draft.js";
import { verifySavedAlphaEditExperimentSource, verifySavedNeuronTrainingExperimentSource } from "./weight-model-versions.js";

const fields = {
  label: z.string().trim().min(1).max(500),
  inferenceModelId: z.string().trim().min(1).max(500).nullable(),
  baseModel: ModelProjectBaseModelSchema.nullable(),
};
/** A trained checkpoint is an immutable saved-version identity. Its original
 * base describes ancestry, never a replacement inference or training source. */
export const ExperimentStartingModelSchema = z.discriminatedUnion("source", [
  z.object({...fields, source: z.literal("inference")}).strict().refine(value => Boolean(value.inferenceModelId),
    {message: "Retain the selected model's original inference identity."}),
  z.object({...fields, source: z.literal("managed")}).strict().refine(value => Boolean(value.baseModel),
    {message: "Retain the selected model's original managed identity."}),
  z.object({...fields, source: z.literal("steering"), inferenceModelId: z.null(), baseModel: ModelProjectBaseModelSchema, steering: SavedSteeringExperimentSourceSchema}).strict(),
  z.object({...fields, source: z.literal("engram"), inferenceModelId: z.null(), baseModel: ModelProjectBaseModelSchema, engram: SavedEngramExperimentSourceSchema}).strict(),
  z.object({...fields, source: z.literal("alphaedit"), inferenceModelId: z.null(), baseModel: ModelProjectBaseModelSchema, alphaedit: SavedAlphaEditExperimentSourceSchema}).strict(),
  z.object({...fields, source: z.literal("neuron_training"), inferenceModelId: z.null(), baseModel: ModelProjectBaseModelSchema, neuronTraining: SavedNeuronTrainingExperimentSourceSchema}).strict(),
  z.object({...fields, source: z.literal("decision"), inferenceModelId: z.null(), baseModel: ModelProjectBaseModelSchema, decision: SavedDecisionExperimentSourceSchema}).strict().superRefine((value, context) => {
    if (canonicalJson(value.baseModel) !== canonicalJson(decisionSourcePreference()))
      context.addIssue({code: "custom", path: ["baseModel"], message: "Retain the saved decision Model's exact adapter release and its own tokenizer."});
  }),
  z.object({...fields, source: z.literal("trained"), inferenceModelId: z.null(),
    baseModel: ModelProjectBaseModelSchema, trainedVersion: z.lazy(() => TrainingModelVersionSchema),
  }).strict().superRefine((value, context) => {
    if (canonicalJson(value.baseModel) !== canonicalJson(value.trainedVersion.request.baseModel))
      context.addIssue({code: "custom", path: ["baseModel"], message: "Retain the trained version's exact original base."});
  }),
]);
export type ExperimentStartingModel = z.infer<typeof ExperimentStartingModelSchema>;
/** Compact steering refs remain untrusted authoring unless an explicit authority
 * resolver supplies the complete immutable version. Compilation requires it. */
export async function parseAndVerifyExperimentStartingModel(raw: unknown, expected: {teamId?: string;
  resolveSteeringVersion?: (source: SavedSteeringExperimentSource) => Promise<unknown>;
  resolveEngramVersion?: (source: SavedEngramExperimentSource) => Promise<unknown>;
  resolveDecisionVersion?: (source: SavedDecisionExperimentSource) => Promise<unknown>;
  resolveAlphaEditVersion?: (source: SavedAlphaEditExperimentSource) => Promise<unknown>;
  resolveNeuronTrainingVersion?: (source: SavedNeuronTrainingExperimentSource) => Promise<unknown>;
} = {}) {
  const value = ExperimentStartingModelSchema.parse(raw);
  if (value.source === "trained") await parseAndVerifyTrainingModelVersion(value.trainedVersion, expected);
  if (value.source === "alphaedit" && expected.resolveAlphaEditVersion) {
    const version = await verifySavedAlphaEditExperimentSource(value.alphaedit, await expected.resolveAlphaEditVersion(value.alphaedit), expected);
    if (canonicalJson(value.baseModel) !== canonicalJson(version.baseModel))
      throw new OpenPondProtocolError("alphaedit_experiment_source_mismatch", "Retain the exact saved AlphaEdit Model and original base.");
  }
  if (value.source === "neuron_training" && expected.resolveNeuronTrainingVersion) {
    const version = await verifySavedNeuronTrainingExperimentSource(value.neuronTraining, await expected.resolveNeuronTrainingVersion(value.neuronTraining), expected);
    if (canonicalJson(value.baseModel) !== canonicalJson(version.baseModel))
      throw new OpenPondProtocolError("neuron_training_experiment_source_mismatch", "Retain the exact saved neuron patch and original base.");
  }
  if (value.source === "decision" && expected.resolveDecisionVersion) {
    const version = await verifySavedDecisionExperimentSource(value.decision, await expected.resolveDecisionVersion(value.decision), expected);
    if (canonicalJson(value.baseModel) !== canonicalJson(version.baseModel))
      throw new OpenPondProtocolError("decision_experiment_source_mismatch", "The authoring source differs from the exact saved decision Model's source release.");
  }
  if (value.source === "engram" && expected.resolveEngramVersion) {
    const version = await parseAndVerifyEngramModelVersion(await expected.resolveEngramVersion(value.engram), {teamId: expected.teamId, modelProjectId: value.engram.modelProjectId});
    if (version.contentHash !== value.engram.versionHash || version.artifact.id !== value.engram.artifact.id
      || version.artifact.contentHash !== value.engram.artifact.contentHash
      || await canonicalSha256(version.artifact.manifest.pins.baseModel) !== value.engram.modelHash
      || canonicalJson(value.baseModel) !== canonicalJson(version.baseModel))
      throw new OpenPondProtocolError("engram_experiment_source_mismatch", "The authoring source differs from the exact saved memory module.");
  }
  if (value.source === "steering" && expected.resolveSteeringVersion) {
    const version = await verifySavedSteeringExperimentSource(value.steering, await expected.resolveSteeringVersion(value.steering), expected);
    if (canonicalJson(value.baseModel) !== canonicalJson(version.publication.baseModel))
      throw new OpenPondProtocolError("steering_experiment_source_mismatch", "The authoring source differs from the saved steering Model's exact base.");
  }
  return value;
}
