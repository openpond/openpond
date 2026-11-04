import { ActivationExperimentFormDraftSchema, type ActivationExperimentFormDraft } from "./activation-experiment-draft.js";
import { ExperimentStartingModelSchema, type ExperimentStartingModel } from "./experiment-starting-model.js";
import { parseAndVerifySavedModelVersion } from "./steering-profile-publication.js";
import { savedSteeringExperimentSource } from "./steering-experiment-source-verification.js";
import { OpenPondProtocolError } from "./protocol.js";

/** Seeds editable replacement controls from a verified immutable source. Prompts,
 * raw limits and spend remain the caller's existing form. Off remains a separate
 * null-profile comparison; editing these controls never stacks interventions. */
export async function activationFormFromSteeringVersion(form: ActivationExperimentFormDraft, resolved: unknown, expected: {teamId?: string} = {}): Promise<ActivationExperimentFormDraft> {
  const current = ActivationExperimentFormDraftSchema.parse(form);
  const version = await parseAndVerifySavedModelVersion(resolved, expected);
  if (version.schemaVersion !== "openpond.steeringModelVersion.v1")
    throw new OpenPondProtocolError("steering_experiment_source_mismatch", "Choose a saved steering Model version.");
  const profile = version.publication.profile;
  return ActivationExperimentFormDraftSchema.parse({...current, baseModel: version.publication.baseModel,
    coordinates: profile.entries.map((entry, index) => ({id: `saved-coordinate-${index + 1}`, layer: String(entry.layer), neuron: String(entry.neuron), dose: String(entry.dose)})),
    doseMultipliers: "1", normalization: profile.normalization, tokenScope: profile.tokenScope,
    startingProfile: savedSteeringExperimentSource(version)});
}
export async function experimentStartingModelFromSteeringVersion(resolved: unknown, options: {teamId?: string; label?: string} = {}): Promise<Extract<ExperimentStartingModel, {source: "steering"}>> {
  const version = await parseAndVerifySavedModelVersion(resolved, options);
  if (version.schemaVersion !== "openpond.steeringModelVersion.v1")
    throw new OpenPondProtocolError("steering_experiment_source_mismatch", "Choose a saved steering Model version.");
  const source = ExperimentStartingModelSchema.parse({source: "steering", label: options.label ?? version.publication.name,
    inferenceModelId: null, baseModel: version.publication.baseModel, steering: savedSteeringExperimentSource(version)});
  if (source.source !== "steering") throw new OpenPondProtocolError("steering_experiment_source_mismatch", "Retain the saved steering source.");
  return source;
}
