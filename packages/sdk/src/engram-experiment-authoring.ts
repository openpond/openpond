import { ExperimentStartingModelSchema, type ExperimentStartingModel } from "./experiment-starting-model.js";
import { EngramExperimentFormDraftSchema, type EngramExperimentFormDraft } from "./engram-experiment-draft.js";
import { parseAndVerifyEngramModelVersion } from "./engram-model-version.js";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

export async function experimentStartingModelFromEngramVersion(raw: unknown, expected: {teamId?: string; label: string}): Promise<Extract<ExperimentStartingModel, {source: "engram"}>> {
  const version = await parseAndVerifyEngramModelVersion(raw, expected);
  const source = ExperimentStartingModelSchema.parse({source: "engram", label: expected.label, inferenceModelId: null,
    baseModel: version.baseModel, engram: {modelProjectId: version.modelProjectId, versionHash: version.contentHash,
      artifact: {id: version.artifact.id, contentHash: version.artifact.contentHash}, modelHash: await canonicalSha256(version.artifact.manifest.pins.baseModel)}});
  if (source.source !== "engram") throw new OpenPondProtocolError("engram_experiment_source_mismatch", "Retain the exact saved memory module.");
  return source;
}
/** Seeds the original learned module as the continuation parent, while keeping
 * the existing editable data, training settings, name and spend approval. */
export async function engramFormFromModelVersion(form: EngramExperimentFormDraft, raw: unknown, expected: {teamId?: string} = {}): Promise<EngramExperimentFormDraft> {
  const current = EngramExperimentFormDraftSchema.parse(form), version = await parseAndVerifyEngramModelVersion(raw, expected);
  return EngramExperimentFormDraftSchema.parse({...current, baseModel: version.baseModel,
    parentArtifact: {id: version.artifact.id, contentHash: version.artifact.contentHash},
    startingModule: {modelProjectId: version.modelProjectId, versionHash: version.contentHash,
      artifact: {id: version.artifact.id, contentHash: version.artifact.contentHash},
      modelHash: await canonicalSha256(version.artifact.manifest.pins.baseModel)}});
}
