import type { Taskset, HarnessRuntimeTargetBinding } from "@openpond/contracts";
import { TaskRecordSchema } from "@openpond/evals/tasksets";
import { requireLearningRelease, requireLearningResource, verifyLearningTextAsset, TaskBatchPackageMetadataSchema, type LearningTextAsset } from "@openpond/evals/learning";
import { compileBoundGraders } from "@openpond/evals/rewards";
import { ModelProjectVersionedRefSchema } from "openpond-sdk/model-projects";
import { contentHash, type CustomVerifierRunner } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import { executeLocalLearningVerifier } from "./learning-grade-executor.js";
import { STARTER_TOOL_ENVIRONMENT } from "./starter-tool-environment.js";
import { readStarterToolEvidence } from "./starter-tool-evidence.js";
import { readImportedLearningTasksetPackage } from "./taskset-package-files.js";

/** Authored Tasksets resolve published Rewards without inventing learning-batch admissions. */
export async function resolveTasksetRewardBinding(store: SqliteStore, taskset: Taskset) {
  if (taskset.metadata.learning !== undefined) return TaskBatchPackageMetadataSchema.parse(taskset.metadata.learning);
  if (taskset.metadata.rewardBinding === undefined) return undefined;
  const reference = ModelProjectVersionedRefSchema.parse(taskset.metadata.rewardBinding);
  return store.learningRepository().transaction(taskset.profileId, async tx => {
    const binding = await requireLearningRelease(tx, "binding", reference);
    const references = [...new Map(binding.sources.map(source => [`${source.reward.id}:${source.reward.revision}:${source.reward.contentHash}`, source.reward])).values()];
    const rewards = await Promise.all(references.map(reference => requireLearningRelease(tx, "reward", reference)));
    return { binding, rewards };
  });
}

export async function resolveTasksetTrainingReward(store: SqliteStore, taskset: Taskset, storeDir?: string) {
  const rewardExecution = await resolveTasksetRewardBinding(store, taskset);
  if (!rewardExecution) return { rewardExecution: undefined, verifierAssets: [] };
  const references = compileBoundGraders(rewardExecution.binding, rewardExecution.rewards)
    .flatMap(grader => grader.kind === "custom_verifier" ? [grader.verifierRef] : []);
  const imported = taskset.metadata.learning === undefined ? undefined : await readImportedLearningTasksetPackage(storeDir, taskset);
  if (imported) {
    const verifierAssets = [...new Map(references.map(reference => {
      const asset = imported.learningResources!.assets.find(asset => asset.id === reference.id);
      if (!asset) throw new Error("Imported batch verifier is missing from its package.");
      verifyLearningTextAsset(asset, reference);
      return [asset.id, asset] as const;
    })).values()];
    return { rewardExecution, verifierAssets };
  }
  const verifierAssets = await store.learningRepository().transaction(taskset.profileId, async tx => {
    const assets = new Map<string, LearningTextAsset>();
    for (const reference of references) {
      const asset = await requireLearningResource(tx, "asset", reference.id, 1);
      verifyLearningTextAsset(asset, reference);
      assets.set(asset.id, asset);
    }
    return [...assets.values()];
  });
  return { rewardExecution, verifierAssets };
}

export async function resolveManagedTasksetReward(store: SqliteStore, taskset: Taskset, options: {
  placement: HarnessRuntimeTargetBinding["placement"];
  hasLearnedPreferenceReward: boolean;
  storeDir?: string;
}) {
  const resolved = await resolveTasksetTrainingReward(store, taskset, options.storeDir);
  if (!resolved.rewardExecution) return resolved;
  const graders = compileBoundGraders(resolved.rewardExecution.binding, resolved.rewardExecution.rewards);
  if (!resolved.rewardExecution.binding.sources.some(source => source.role === "evaluation" && source.weight > 0)) {
    throw new Error("Managed training requires a positively weighted evaluation Reward source for retained validation.");
  }
  if (options.placement !== "remote" || taskset.environment.kind === "work"
    || taskset.capabilities.requiresState || taskset.capabilities.requiresTools
    || graders.some(grader => grader.kind === "human" || grader.kind === "model_judge")
    || taskset.tasks.some(task => task.privilegedContextRef !== null)
    || !resolved.rewardExecution.binding.sources.some(source => source.role === "training" && source.weight > 0)
    || options.hasLearnedPreferenceReward) {
    throw new Error("This Reward binding requires an additional managed execution adapter.");
  }
  return resolved;
}

export async function createTasksetBindingVerifier(store: SqliteStore, taskset: Taskset, storeDir?: string): Promise<CustomVerifierRunner> {
  const resources = await resolveTasksetRewardBinding(store, taskset);
  if (!resources) throw new Error("The Taskset has no published Reward binding.");
  const graders = compileBoundGraders(resources.binding, resources.rewards);
  return async ({ grader, task, attempt, signal }) => {
    const saved = taskset.tasks.find(candidate => candidate.id === task.id);
    if (!saved || contentHash(saved) !== contentHash(task)) throw new Error("Task differs from the selected immutable Taskset.");
    let evaluatorContext: Record<string, unknown> | null = null;
    if (taskset.environment.entrypoint === STARTER_TOOL_ENVIRONMENT) {
      if (!storeDir) throw new Error("Tool grading requires the execution owner's artifact directory.");
      evaluatorContext = await readStarterToolEvidence({ store, storeDir, taskset, task, attempt });
    } else if (task.privilegedContextRef !== null) throw new Error("This authored Taskset requires a private evaluator-context resolver.");
    const bound = graders.find(candidate => candidate.id === grader.id);
    if (bound?.kind !== "custom_verifier") throw new Error("The verifier is absent from the published Reward binding.");
    const released = TaskRecordSchema.parse({ id: task.id, clusterKey: task.clusterKey, split: task.split, input: task.input, expectedOutput: task.expectedOutput, policyVisibleContext: task.policyVisibleContext, privilegedContextRef: task.privilegedContextRef, artifactRefs: [], tags: task.tags });
    return executeLocalLearningVerifier({ repository: store.learningRepository(), scope: taskset.profileId, grader: bound, task: released,
      evidence: { output: attempt.output, artifactRefs: attempt.artifactRefs, runtimeEventRefs: attempt.runtimeEventRefs, infrastructureError: attempt.infrastructureError }, evaluatorContext, signal });
  };
}
