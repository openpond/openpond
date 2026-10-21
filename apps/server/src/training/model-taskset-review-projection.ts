import { TasksetSchema, type Taskset } from "@openpond/contracts";
import { computeTasksetHash } from "@openpond/taskset-sdk";
import { contentHash, ImmutableAssetRefSchema } from "@openpond/harness";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import { reviewedModelSharedResources } from "./model-taskset-shared-resource-review.js";

/** A Model-owned Reward edit keeps the owner's review of the same task inputs.
 * Package import defaults still apply to newly fetched, unreviewed packages.
 * Graders, execution resources and readiness come from the new compilation. */
export function retainModelTasksetInputReview(compiled: Taskset, reviewed: Taskset, reviewedSourcePackage?: TasksetPackage): Taskset {
  if (compiled.profileId !== reviewed.profileId || compiled.tasks.length !== reviewed.tasks.length) {
    throw new Error("Model Taskset review differs from its compiled task scope.");
  }
  const sources = new Map(reviewed.sourceRefs.map(source => [source.id, source]));
  const shared = reviewedModelSharedResources(reviewed, reviewedSourcePackage);
  const tasks = compiled.tasks.map(task => {
    const original = reviewed.tasks.find(candidate => candidate.id === task.id);
    if (!original) throw new Error("Model Taskset review is missing a compiled task.");
    if (contentHash(task.input) !== contentHash(original.input) || contentHash(task.expectedOutput) !== contentHash(original.expectedOutput)
      || contentHash(task.policyVisibleContext) !== contentHash(original.policyVisibleContext)) {
      throw new Error("Model Taskset review differs from its compiled task content.");
    }
    const assets = (task.assets ?? []).map(asset => {
      const previous = original.assets?.find(candidate => candidate.id === asset.id);
      if (!previous) {
        const resource = shared?.get(asset.id);
        const exact = resource?.asset;
        const portable = ImmutableAssetRefSchema.safeParse(asset.metadata.portableAsset);
        if (!exact || !portable.success || contentHash(portable.data) !== contentHash(exact)
          || asset.artifactRef !== exact.path || asset.stagingPath !== exact.path
          || asset.sha256 !== exact.contentHash || asset.sizeBytes !== exact.sizeBytes
          || asset.mediaType !== exact.mediaType || asset.fileName !== exact.path.split("/").at(-1)
          || asset.split !== task.split) throw new Error("Model Taskset review differs from its compiled shared resource.");
        return { ...asset, sourceRefId: resource!.sourceRefId };
      }
      const portable = ImmutableAssetRefSchema.safeParse(previous?.metadata.portableAsset);
      const samePath = previous?.artifactRef === asset.artifactRef || (portable.success
        && portable.data.path === asset.artifactRef && portable.data.id === asset.id
        && portable.data.contentHash === asset.sha256 && portable.data.sizeBytes === asset.sizeBytes
        && portable.data.mediaType === asset.mediaType && portable.data.visibility === "policy");
      if (!previous || previous.sha256 !== asset.sha256 || previous.sizeBytes !== asset.sizeBytes
        || !samePath || previous.mediaType !== asset.mediaType
        || previous.fileName !== asset.fileName || previous.split !== task.split
        || !original.sourceRefs.includes(previous.sourceRefId) || !sources.has(previous.sourceRefId)) {
        throw new Error("Model Taskset review differs from its compiled input asset.");
      }
      return { ...asset, sourceRefId: previous.sourceRefId,
        ...(previous.stagingPath === undefined ? {} : { stagingPath: previous.stagingPath }) };
    });
    if ((original.assets ?? []).some(previous => !assets.some(asset => asset.id === previous.id))) throw new Error("Model Taskset review lost an input asset.");
    return { ...task, sourceRefs: [...new Set([...original.sourceRefs, ...assets.map(asset => asset.sourceRefId)])], assets };
  });
  const binding = compiled.metadata.rewardBinding as { id: string } | undefined;
  const projected = TasksetSchema.parse({ ...compiled, sourceRefs: reviewed.sourceRefs, tasks,
    metadata: { ...compiled.metadata, ...Object.fromEntries(["trainingMethod", "diagnosis", "buildIntent"]
      .filter(key => reviewed.metadata[key] !== undefined).map(key => [key, reviewed.metadata[key]])) },
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
