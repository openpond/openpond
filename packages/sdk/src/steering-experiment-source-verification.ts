import { canonicalJson, OpenPondProtocolError } from "./protocol.js";
import { parseAndVerifySavedModelVersion, type SteeringModelVersion } from "./steering-profile-publication.js";
import { SavedSteeringExperimentSourceSchema, type SavedSteeringExperimentSource } from "./steering-experiment-source.js";

export function savedSteeringExperimentSource(version: SteeringModelVersion): SavedSteeringExperimentSource {
  return SavedSteeringExperimentSourceSchema.parse({modelProjectId: version.modelProjectId, versionHash: version.contentHash,
    publication: {id: version.publication.id, revision: version.publication.revision, contentHash: version.publication.contentHash},
    profileHash: version.publication.profile.contentHash});
}
/** The host supplies its explicitly authorized immutable version. There is no
 * network lookup, latest-version substitution or inferred base-model fallback. */
export async function verifySavedSteeringExperimentSource(raw: unknown, resolved: unknown, expected: {teamId?: string} = {}) {
  const source = SavedSteeringExperimentSourceSchema.parse(raw);
  const version = await parseAndVerifySavedModelVersion(resolved, {...expected, modelProjectId: source.modelProjectId});
  if (version.schemaVersion !== "openpond.steeringModelVersion.v1" || canonicalJson(source) !== canonicalJson(savedSteeringExperimentSource(version)))
    throw new OpenPondProtocolError("steering_experiment_source_mismatch", "Resolve the exact saved steering Model version, publication and profile.");
  return version;
}
