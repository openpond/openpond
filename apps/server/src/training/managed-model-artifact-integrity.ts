import type { ModelArtifactLineage, TrainingArtifact, TrainingJob } from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";
import { readManagedTrainingRetainedOutputs, type ManagedTrainingOutputAccess } from "./managed-training-retained-outputs.js";

export async function assertManagedModelArtifactIntegrity(input: {
  store: SqliteStore;
  profileId: string;
  model: ModelArtifactLineage;
  job: TrainingJob;
  artifact: TrainingArtifact;
  resolveAccess?: () => Promise<ManagedTrainingOutputAccess>;
  fetch?: typeof fetch;
}) {
  if (!input.resolveAccess) throw new Error("Hosted training access is unavailable for artifact verification.");
  const project = await input.store.getModelProject(input.model.modelId);
  if (!project || project.profileId !== input.profileId || input.job.metadata.modelProjectId !== project.id) {
    throw new Error("The Model does not belong to the active Profile.");
  }
  const { artifact } = input;
  const remoteJobId = artifact.metadata.managedRlJobId;
  const outputId = artifact.metadata.managedRlOutputId;
  if (artifact.jobId !== input.job.id || artifact.id !== input.model.artifactId || artifact.kind !== "adapter"
    || artifact.metadata.managedRlCandidate !== true || typeof remoteJobId !== "string" || typeof outputId !== "string"
    || artifact.path !== `sandbox-managed-rl://${encodeURIComponent(remoteJobId)}/${encodeURIComponent(outputId)}`) {
    throw new Error("The hosted artifact does not retain an exact candidate output reference.");
  }
  const access = await input.resolveAccess();
  if (artifact.metadata.managedRlTeamId !== access.teamId) throw new Error("The hosted artifact belongs to a different workspace.");
  const retained = await readManagedTrainingRetainedOutputs({ project, jobId: remoteJobId, access, fetch: input.fetch });
  if (!retained.adapter || retained.adapter.id !== outputId || retained.adapter.contentHash !== artifact.sha256
    || retained.adapter.sizeBytes !== artifact.sizeBytes || retained.receipt.manifestHash !== artifact.metadata.manifestHash) {
    throw new Error("The hosted artifact changed from its completed training receipt.");
  }
}
