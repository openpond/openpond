import type { Taskset } from "@openpond/contracts";
import { assertLearningContentHash, learningRef, learningResourceSchemas, sealLearningContent, verifyLearningTextAsset, type LearningResourceFor, type LearningTextAsset } from "@openpond/evals/learning";
import { compileBoundGraders } from "@openpond/evals/rewards";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { projectLearningBatchGraders, projectPortableTaskRecord } from "@openpond/taskset-sdk";
import { ModelProjectVersionedRefSchema, OpenPondModelProjectApiError, type ModelProjectSaveRequest } from "openpond-sdk/model-projects";
import { ModelStarterExecutionSchema, ModelTasksetPackageSchema, modelStarterExecutionAssetId, type ModelTasksetPackage } from "openpond-sdk/model-starters";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import { canonicalJson } from "openpond-sdk/training";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

export function readSelectedModelReward(db: OpenPondSqliteConnection, scope: string, reference: NonNullable<ModelProjectSaveRequest["project"]["trainingSetup"]["rewardBindingRef"]>) {
  function read<K extends "binding" | "reward" | "asset">(kind: K, ref: { id: string; revision: number; contentHash?: string }): LearningResourceFor<K> {
    const row = db.get<{ payload: string }>("SELECT payload FROM learning_revisions WHERE scope = ? AND kind = ? AND id = ? AND revision = ?", [scope, kind, ref.id, ref.revision]);
    if (!row) fail(404, "model_reward_unavailable", `The exact ${kind} resource is unavailable in this Profile.`);
    const resource = learningResourceSchemas[kind].parse(JSON.parse(row.payload));
    assertLearningContentHash(resource);
    if (ref.contentHash && resource.contentHash !== ref.contentHash) fail(409, "model_reward_changed", "The selected resource does not match its immutable content hash.");
    return resource as LearningResourceFor<K>;
  }
  const rewardBinding = read("binding", reference);
  const rewards = [...new Map(rewardBinding.sources.map(source => [canonicalJson(source.reward), read("reward", source.reward)])).values()];
  const assets = new Map<string, LearningTextAsset>();
  for (const reward of rewards) {
    const implementation = reward.implementation;
    for (const ref of [...reward.assets, ...("verifierRef" in implementation ? [implementation.verifierRef] : []), ...("rubricRef" in implementation ? [implementation.rubricRef] : []), ...("inputContract" in implementation ? [implementation.inputContract] : [])]) {
      if (!assets.has(ref.id)) assets.set(ref.id, read("asset", { id: ref.id, revision: 1 }));
      verifyLearningTextAsset(assets.get(ref.id)!, ref);
    }
  }
  return { rewardBinding, rewards, assets: [...assets.values()] };
}

/** The caller authorizes this exact Taskset in its serialized save transaction. */
export function readModelTasksetSource(db: OpenPondSqliteConnection, source: Taskset, selectedRewardRef: NonNullable<ModelProjectSaveRequest["project"]["trainingSetup"]["rewardBindingRef"]>, completeSource?: TasksetPackage) {
  const bindingRef = ModelProjectVersionedRefSchema.parse(source.metadata.rewardBinding);
  const read = <K extends "asset" | "definition" | "binding" | "reward">(kind: K, ref: { id: string; revision: number; contentHash?: string }): LearningResourceFor<K> => {
    const row = db.get<{ payload: string }>("SELECT payload FROM learning_revisions WHERE scope = ? AND kind = ? AND id = ? AND revision = ?", [source.profileId, kind, ref.id, ref.revision]);
    if (!row) fail(404, "model_reward_unavailable", `The exact ${kind} resource is unavailable in this Profile.`);
    const resource = learningResourceSchemas[kind].parse(JSON.parse(row.payload));
    assertLearningContentHash(resource);
    if (ref.contentHash && resource.contentHash !== ref.contentHash) fail(409, "model_reward_changed", "The selected resource does not match its immutable content hash.");
    return resource as LearningResourceFor<K>;
  };
  const taskDefinition = read("definition", ModelProjectVersionedRefSchema.parse(source.metadata.taskDefinition));
  if (canonicalJson(source.policy) !== canonicalJson(taskDefinition.execution.policy) ||
      canonicalJson(source.environment.metadata.portableEnvironment) !== canonicalJson(taskDefinition.execution.environment) ||
      canonicalJson(source.environment.metadata.portableTools) !== canonicalJson(taskDefinition.execution.tools)) fail(409, "model_taskset_context_changed", "Taskset context differs from its immutable task definition.");
  const rewardBinding = read("binding", bindingRef);
  const rewards = [...new Map(rewardBinding.sources.map(check => [canonicalJson(check.reward), read("reward", check.reward)])).values()];
  if (source.metadata.rewardExecution !== undefined && canonicalJson(source.metadata.rewardExecution) !== canonicalJson({ binding: rewardBinding, rewards })) fail(409, "model_taskset_rewards_changed", "Taskset embedded Rewards differ from their immutable binding.");
  const selectedBinding = read("binding", selectedRewardRef);
  const selectedRewards = [...new Map(selectedBinding.sources.map(check => [canonicalJson(check.reward), read("reward", check.reward)])).values()];
  const assets = new Map<string, LearningTextAsset>((completeSource?.modelResources?.assets ?? []).map(asset => [asset.id, asset]));
  const addAsset = (id: string) => { if (!assets.has(id)) assets.set(id, read("asset", { id, revision: 1 })); };
  for (const reward of [...rewards, ...selectedRewards]) {
    const implementation = reward.implementation;
    for (const ref of [...reward.assets, ...("verifierRef" in implementation ? [implementation.verifierRef] : []), ...("rubricRef" in implementation ? [implementation.rubricRef] : []), ...("inputContract" in implementation ? [implementation.inputContract] : [])]) addAsset(ref.id);
  }
  let execution: ModelTasksetPackage["execution"];
  const executionResources = ModelTasksetPackageSchema.shape.executionResources.parse(source.environment.metadata.portableExecutionResources);
  if (taskDefinition.execution.environment.entrypoint === "openpond.javascript-environment.v1") {
    const asset = read("asset", { id: modelStarterExecutionAssetId(taskDefinition.execution), revision: 1 });
    execution = ModelStarterExecutionSchema.parse(JSON.parse(verifyLearningTextAsset(asset, asset.asset)));
    for (const ref of [execution.javascript.module, execution.environment.actionSchemaRef, execution.environment.observationSchemaRef, execution.environment.stateSchemaRef]) if (ref) addAsset(ref.id);
  }
  for (const task of source.tasks) if (task.privilegedContextRef) addAsset(task.privilegedContextRef);
  if (canonicalJson(source.graders) !== canonicalJson(projectLearningBatchGraders(rewardBinding, rewards, [...assets.values()]))) fail(409, "model_taskset_graders_changed", "Taskset graders differ from their immutable Reward binding.");
  const taskset = TasksetReleaseSchema.parse(sealLearningContent({
    schemaVersion: "openpond.tasksetRelease.v2", id: source.id, revision: source.revision,
    ...taskDefinition.execution, graders: compileBoundGraders(rewardBinding, rewards),
    ...(source.metrics ? { metrics: source.metrics } : {}),
    tasks: source.tasks.map(task => {
      const projected = projectPortableTaskRecord(task);
      // Existing source revisions omit undeclared output contracts. Preserve
      // those exact bytes while retaining explicit or pinned output schemas.
      if (task.requiredOutputs === undefined && task.metadata.portableTaskRecord === undefined) delete projected.requiredOutputs;
      return projected;
    }),
    metadata: source.metadata.derivedPortableMetadata ?? { localSource: learningRef(source), starter: { taskDefinition: learningRef(taskDefinition), rewardBinding: bindingRef } },
  }));
  const sourcePackage = completeSource ? { ...completeSource.modelResources!, taskset: completeSource.taskset, executionResources: { environment: completeSource.environment, verifierSet: completeSource.verifierSet } } : { taskset, taskDefinition, rewardBinding, rewards, assets: [...assets.values()], ...(executionResources ? { executionResources } : {}), ...(execution ? { execution } : {}) };
  return { sourcePackage, selectedBinding, selectedRewards, assets };
}

function fail(status: number, code: string, message: string): never {
  throw new OpenPondModelProjectApiError(status, { schemaVersion: "openpond.modelProjectApiError.v2", code, message, retryable: false, requestId: null, details: {} });
}
