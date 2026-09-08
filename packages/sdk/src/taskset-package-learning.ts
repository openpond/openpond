import { z } from "zod";
import { contentHash, sha256 } from "@openpond/harness";
import { TaskBatchSchema, TaskEvidenceSchema, TaskAdmissionDecisionSchema, LearningSourceSchema, LearningTextAssetSchema,
  assertLearningContentHash, compileTaskBatch, learningRef, sameLearningRef, taskBatchPackageMetadata, verifyLearningTextAsset } from "@openpond/evals/learning";
import type { TasksetRelease } from "@openpond/evals/tasksets";
import { canonicalJson } from "./training.js";

/** Review snapshots travel with their exact batch; importing them is not a
 * new local admission or permission to train. */
export const TasksetPackageLearningResourcesSchema = z.object({
  batch: TaskBatchSchema,
  evidence: z.array(TaskEvidenceSchema).min(1).max(10_000),
  decisions: z.array(TaskAdmissionDecisionSchema).min(1).max(10_000),
  sources: z.array(LearningSourceSchema).min(1).max(10_000),
  assets: z.array(LearningTextAssetSchema).max(1_000),
}).strict();
export type TasksetPackageLearningResources = z.infer<typeof TasksetPackageLearningResourcesSchema>;

export function learningPackageContextFiles(resources: TasksetPackageLearningResources) {
  return resources.evidence.filter(evidence => evidence.submission.evaluatorContext !== null).map(evidence => {
    const text = canonicalJson(evidence.submission.evaluatorContext);
    const bytes = new TextEncoder().encode(text);
    return { asset: { id: `task-evidence:${evidence.contentHash}`, path: `learning/context/${evidence.contentHash}.json`,
      contentHash: sha256(bytes), sizeBytes: bytes.byteLength, mediaType: "application/json", visibility: "host_private" as const },
      base64: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join("")) };
  });
}

export function validateTasksetLearningResources(taskset: TasksetRelease, input: unknown) {
  const resources = TasksetPackageLearningResourcesSchema.parse(input);
  const metadata = taskBatchPackageMetadata(taskset);
  if (!sameLearningRef(learningRef(resources.batch), metadata.batch)) throw new Error("Taskset learning batch differs from its admission metadata.");
  for (const collection of [resources.evidence, resources.decisions, resources.sources, resources.assets]) {
    const identities = new Set<string>();
    for (const resource of collection) {
      assertLearningContentHash(resource);
      const key = `${resource.id}:${resource.revision}`;
      if (identities.has(key)) throw new Error("Taskset learning resource identities must be unique.");
      identities.add(key);
    }
  }
  if (resources.evidence.length !== resources.batch.examples.length || resources.decisions.length !== resources.batch.examples.length) throw new Error("Taskset learning snapshots must match the admitted batch inventory.");
  for (const evidence of resources.evidence) {
    const source = resources.sources.find(source => sameLearningRef(learningRef(source), evidence.source));
    if (!source || !sameLearningRef(source.taskDefinition, learningRef(metadata.definition))) throw new Error("Taskset evidence source differs from its task definition.");
  }
  if (resources.sources.some(source => !resources.evidence.some(evidence => sameLearningRef(evidence.source, learningRef(source))))) throw new Error("Taskset package includes an unrelated learning source.");
  const rewardAssets = metadata.rewards.flatMap(reward => [...reward.assets,
    ...(reward.implementation.kind === "custom_verifier" ? [reward.implementation.verifierRef]
      : reward.implementation.kind === "model_judge" || reward.implementation.kind === "human" ? [reward.implementation.rubricRef] : []),
    ...("inputContract" in reward.implementation ? [reward.implementation.inputContract] : []),
  ]);
  for (const ref of rewardAssets) {
    const asset = resources.assets.find(asset => asset.id === ref.id);
    if (!asset) throw new Error("Taskset learning Reward asset is missing.");
    verifyLearningTextAsset(asset, ref);
  }
  if (resources.assets.some(asset => !rewardAssets.some(ref => ref.id === asset.id))) throw new Error("Taskset package includes an unrelated learning asset.");
  const compiled = compileTaskBatch({ batch: resources.batch, definition: metadata.definition, binding: metadata.binding,
    rewards: metadata.rewards, evidence: resources.evidence, decisions: resources.decisions });
  const compiledMetadata = taskBatchPackageMetadata(compiled);
  if (contentHash(compiledMetadata) !== contentHash(metadata)) throw new Error("Taskset admission metadata differs from its reviewed snapshots.");
  const execution = (release: TasksetRelease) => ({ policy: release.policy, environment: release.environment, tools: release.tools });
  if (contentHash(execution(compiled)) !== contentHash(execution(taskset))) throw new Error("Taskset execution differs from its reviewed task definition.");
  const taskContent = (task: TasksetRelease["tasks"][number]) => ({ id: task.id, clusterKey: task.clusterKey, split: task.split,
    input: task.input, expectedOutput: task.expectedOutput, policyVisibleContext: task.policyVisibleContext,
    privilegedContextRef: task.privilegedContextRef, artifactRefs: task.artifactRefs, requiredOutputs: task.requiredOutputs ?? [], tags: task.tags });
  if (contentHash(compiled.tasks.map(taskContent)) !== contentHash(taskset.tasks.map(taskContent))) throw new Error("Taskset rows differ from their reviewed evidence.");
  return resources;
}
