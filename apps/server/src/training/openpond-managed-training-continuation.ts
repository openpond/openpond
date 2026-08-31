import {
  recordOrEmpty,
  requiredHash,
  requiredRecord,
  requiredRef,
  requiredStringValue,
} from "./openpond-managed-training-adapter-projection.js";

export function continuationResumeFrom(recipe: unknown) {
  const recipeRecord = recordOrEmpty(recipe);
  if (!("continuation" in recipeRecord)) return null;
  const continuation = requiredRecord(
    recipeRecord.continuation,
    "Managed continuation",
  );
  if (
    continuation.schemaVersion !==
      "openpond.crossJobContinuationRequest.v1" ||
    !["continue", "reset"].includes(String(continuation.optimizerMode))
  ) {
    throw new Error("Managed continuation contract is invalid.");
  }
  const parentArtifact = requiredRef(
    continuation.parentArtifact,
    "Managed continuation parent artifact",
  );
  const sourceArtifact = requiredRecord(
    continuation.sourceArtifact,
    "Managed continuation source artifact",
  );
  requiredStringValue(sourceArtifact.jobId, "Managed continuation source Job");
  requiredStringValue(
    sourceArtifact.artifactId,
    "Managed continuation source artifact id",
  );
  requiredStringValue(
    sourceArtifact.checkpointId,
    "Managed continuation source checkpoint",
  );
  const sourceHash = requiredHash(
    sourceArtifact.contentHash,
    "Managed continuation source artifact hash",
  );
  if (sourceHash !== parentArtifact.contentHash) {
    throw new Error("Managed continuation source identity is invalid.");
  }
  return parentArtifact;
}
