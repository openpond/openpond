import type { ModelProject } from "openpond-sdk/model-projects";
import type { SqliteStore } from "../store/store.js";

type Reader = Pick<SqliteStore, "listModelProjects" | "getModelProject" | "getTasksetRevision">;

function summary(project: ModelProject) {
  const setup = project.trainingSetup;
  return {
    id: project.id,
    profileId: project.profileId,
    name: project.name,
    revision: project.revision,
    defaultBaseModel: project.defaultBaseModel,
    trainingSetup: {
      tasksetRef: setup.tasksetRef,
      evaluationTasksetRef: setup.evaluationTasksetRef,
      tasksetRelease: setup.tasksetRelease,
      harnessRelease: setup.harnessRelease,
      rewardBindingRef: setup.rewardBindingRef,
      baseModel: setup.baseModel,
      method: setup.method,
      destinationId: setup.destinationId,
      managedRolloutPlacement: setup.managedRolloutPlacement,
      managedGpuPlacementObjective: setup.managedGpuPlacementObjective,
      managedGpuRequirement: setup.managedGpuRequirement,
      runPreset: setup.runPreset,
      preferredMaximumSpendUsd: setup.preferredMaximumSpendUsd,
      preferredRetentionDays: setup.preferredRetentionDays,
      recipePresent: setup.recipe != null,
    },
    hosted: project.hosted ? {
      projectId: project.hosted.projectId,
      portableProjectId: project.hosted.portableProjectId,
      teamId: project.hosted.teamId,
      apiOrigin: project.hosted.apiOrigin,
      revision: project.hosted.revision,
    } : null,
    updatedAt: project.updatedAt,
  };
}

function hash(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

/** Reads canonical saved pins only. No reconciliation, publication, package
 * export or access to private task/verifier bytes is part of inspection. */
export async function inspectLocalModelProjects(store: Reader, modelId?: string, profileId?: string) {
  if (!modelId) {
    return {
      projects: (await store.listModelProjects())
        .filter(project => !profileId || project.profileId === profileId)
        .map(summary),
    };
  }
  const project = await store.getModelProject(modelId);
  if (!project || profileId && project.profileId !== profileId) {
    throw new Error("Saved Model is unavailable in the requested local Profile.");
  }
  const tasksets = await Promise.all((["tasksetRef", "evaluationTasksetRef"] as const).map(async purpose => {
    const reference = project.trainingSetup[purpose];
    if (!reference) return { purpose, reference: null, available: false, taskset: null };
    const taskset = await store.getTasksetRevision(reference.id, reference.revision, reference.contentHash);
    if (!taskset || taskset.profileId !== project.profileId || taskset.id !== reference.id
      || taskset.revision !== reference.revision || taskset.contentHash !== reference.contentHash) {
      return { purpose, reference, available: false, taskset: null };
    }
    const splits: Record<string, number> = {};
    for (const task of taskset.tasks) splits[task.split] = (splits[task.split] ?? 0) + 1;
    return {
      purpose,
      reference,
      available: true,
      taskset: {
        id: taskset.id,
        profileId: taskset.profileId,
        revision: taskset.revision,
        contentHash: taskset.contentHash,
        name: taskset.name,
        taskCount: taskset.tasks.length,
        splits,
        importedPackageHash: hash(taskset.metadata.importedPackageHash),
        graders: taskset.graders.map(grader => ({
          id: grader.id,
          version: grader.version,
          kind: grader.kind,
          weight: grader.weight,
          hardGate: grader.hardGate,
          rewardEligible: grader.rewardEligible,
          verifierHash: hash((grader.metadata.portableVerifierRef as { contentHash?: unknown } | undefined)?.contentHash),
        })),
      },
    };
  }));
  return { project: summary(project), tasksets };
}
