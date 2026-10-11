import { TasksetSchema, type Taskset } from "@openpond/contracts";
import { computeTasksetHash } from "@openpond/taskset-sdk";

/** A Model-owned Reward edit keeps the owner's review of the same task inputs.
 * Package import defaults still apply to newly fetched, unreviewed packages.
 * Graders, execution resources and readiness come from the new compilation. */
export function retainModelTasksetInputReview(compiled: Taskset, reviewed: Taskset): Taskset {
  if (compiled.profileId !== reviewed.profileId || compiled.tasks.length !== reviewed.tasks.length) {
    throw new Error("Model Taskset review differs from its compiled task scope.");
  }
  const sources = new Map(reviewed.sourceRefs.map(source => [source.id, source]));
  const tasks = compiled.tasks.map(task => {
    const original = reviewed.tasks.find(candidate => candidate.id === task.id);
    if (!original) throw new Error("Model Taskset review is missing a compiled task.");
    const assets = (task.assets ?? []).map(asset => {
      const previous = original.assets?.find(candidate => candidate.id === asset.id);
      if (!previous || previous.sha256 !== asset.sha256 || previous.sizeBytes !== asset.sizeBytes
        || previous.artifactRef !== asset.artifactRef || previous.mediaType !== asset.mediaType
        || previous.fileName !== asset.fileName || previous.split !== task.split
        || !original.sourceRefs.includes(previous.sourceRefId) || !sources.has(previous.sourceRefId)) {
        throw new Error("Model Taskset review differs from its compiled input asset.");
      }
      return { ...asset, sourceRefId: previous.sourceRefId,
        ...(previous.stagingPath === undefined ? {} : { stagingPath: previous.stagingPath }) };
    });
    if (assets.length !== (original.assets?.length ?? 0)) throw new Error("Model Taskset review lost an input asset.");
    return { ...task, sourceRefs: original.sourceRefs, assets };
  });
  const binding = compiled.metadata.rewardBinding as { id: string } | undefined;
  const projected = TasksetSchema.parse({ ...compiled, sourceRefs: reviewed.sourceRefs, tasks,
    capabilities: { ...compiled.capabilities, supportedSignals: reviewed.capabilities.supportedSignals,
      compatibleMethods: reviewed.capabilities.compatibleMethods },
    graderFixtures: reviewed.graderFixtures,
    learningSignals: { ...reviewed.learningSignals, rewards: reviewed.learningSignals.rewards.map(signal => binding ? {
      ...signal, artifactRef: binding.id,
      rules: [{ id: binding.id, points: 1, condition: "Execute the published Reward binding with its declared normalization, weights and required gates." }],
    } : signal) },
  });
  return TasksetSchema.parse({ ...projected, contentHash: computeTasksetHash(projected) });
}
