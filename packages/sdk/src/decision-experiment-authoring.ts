import { ExperimentStartingModelSchema, type ExperimentStartingModel } from "./experiment-starting-model.js";
import { parseAndVerifyDecisionModelVersion } from "./decision-model-version.js";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

/** Names the exact saved classifier without exposing it as a generic chat
 * alias. Train and score are both authored through the same decision form. */
export async function experimentStartingModelFromDecisionVersion(raw: unknown, expected: {
  teamId?: string; ownerUserId?: string; label: string;
}): Promise<Extract<ExperimentStartingModel, { source: "decision" }>> {
  const version = await parseAndVerifyDecisionModelVersion(raw, expected);
  const source = ExperimentStartingModelSchema.parse({
    source: "decision", label: expected.label, inferenceModelId: null, baseModel: version.baseModel,
    decision: { modelProjectId: version.modelProjectId, versionHash: version.contentHash,
      artifact: { id: version.artifact.id, contentHash: version.artifact.contentHash },
      modelHash: await canonicalSha256(version.request.model) },
  });
  if (source.source !== "decision") throw new OpenPondProtocolError("decision_experiment_source_mismatch", "Retain the exact saved decision Model.");
  return source;
}
