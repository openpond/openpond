import { ExperimentStartingModelSchema, type ExperimentStartingModel } from "./experiment-starting-model.js";
import { AlphaEditExperimentFormDraftSchema, type AlphaEditExperimentFormDraft } from "./alphaedit-experiment-draft.js";
import { parseAndVerifyAlphaEditModelVersion, parseAndVerifyNeuronTrainingModelVersion } from "./weight-model-versions.js";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

type Scope = {teamId?: string; ownerUserId?: string};
export async function experimentStartingModelFromAlphaEditVersion(raw: unknown, expected: Scope & {label: string}): Promise<Extract<ExperimentStartingModel, {source: "alphaedit"}>> {
  const version = await parseAndVerifyAlphaEditModelVersion(raw, expected);
  const source = ExperimentStartingModelSchema.parse({source: "alphaedit", label: expected.label, inferenceModelId: null,
    baseModel: version.baseModel, alphaedit: {modelProjectId: version.modelProjectId, versionHash: version.contentHash,
      artifact: {id: version.artifact.id, contentHash: version.artifact.contentHash}, modelHash: await canonicalSha256(version.request.model)}});
  if (source.source !== "alphaedit") throw new OpenPondProtocolError("alphaedit_experiment_source_mismatch", "Retain the exact saved AlphaEdit Model.");
  return source;
}
/** Continuation must reuse the parent's covariance/projector definition and
 * preservation evidence. A different edit batch and spend remain editable. */
export async function alphaEditFormFromModelVersion(form: AlphaEditExperimentFormDraft, raw: unknown, expected: Scope = {}): Promise<AlphaEditExperimentFormDraft> {
  const current = AlphaEditExperimentFormDraftSchema.parse(form), version = await parseAndVerifyAlphaEditModelVersion(raw, expected);
  return AlphaEditExperimentFormDraftSchema.parse({...current, baseModel: version.baseModel,
    preservationBatch: version.request.data.preservation.batch,
    config: {layers: version.request.config.layers.join(", "), lossLayer: String(version.request.config.lossLayer),
      contextTemplateGroups: JSON.stringify(version.request.config.contextTemplateGroups),
      nullspaceThreshold: String(version.request.config.nullspaceThreshold), l2: String(version.request.config.l2)},
    parentArtifact: {id: version.artifact.id, contentHash: version.artifact.contentHash},
    startingModule: {modelProjectId: version.modelProjectId, versionHash: version.contentHash,
      artifact: {id: version.artifact.id, contentHash: version.artifact.contentHash}, modelHash: await canonicalSha256(version.request.model)}});
}
/** Retains a trained patch for Model/serving selection. Training a new patch
 * from this source is explicitly rejected by experiment setup validation. */
export async function experimentStartingModelFromNeuronTrainingVersion(raw: unknown, expected: Scope & {label: string}): Promise<Extract<ExperimentStartingModel, {source: "neuron_training"}>> {
  const version = await parseAndVerifyNeuronTrainingModelVersion(raw, expected);
  const source = ExperimentStartingModelSchema.parse({source: "neuron_training", label: expected.label, inferenceModelId: null,
    baseModel: version.baseModel, neuronTraining: {modelProjectId: version.modelProjectId, versionHash: version.contentHash,
      artifact: {id: version.artifact.id, contentHash: version.artifact.contentHash}, modelHash: await canonicalSha256(version.request.model)}});
  if (source.source !== "neuron_training") throw new OpenPondProtocolError("neuron_training_experiment_source_mismatch", "Retain the exact saved neuron weights.");
  return source;
}
