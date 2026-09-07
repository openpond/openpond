import type { Taskset } from "@openpond/contracts";
import {
  requireLearningRelease,
  requireLearningResource,
  verifyLearningTextAsset,
  type LearningTextAsset,
} from "@openpond/evals/learning";
import type { TasksetRelease } from "@openpond/evals/tasksets";
import { ModelProjectVersionedRefSchema } from "openpond-sdk/model-projects";
import {
  ModelStarterExecutionSchema,
  modelStarterExecutionAssetId,
  validateModelTasksetPackage,
  type ModelTasksetPackage,
} from "openpond-sdk/model-starters";
import type { SqliteStore } from "../store/store.js";

/** Read the immutable authoring graph in one Profile-scoped transaction.
 * The complete validator checks every reference against the exported release;
 * a current binding or similarly named asset cannot substitute for its pins. */
export async function resolveLocalTasksetModelResources(input: {
  store: SqliteStore;
  taskset: Taskset;
  release: TasksetRelease;
  executionResources: NonNullable<ModelTasksetPackage["executionResources"]>;
}): Promise<ModelTasksetPackage> {
  return input.store.learningRepository().transaction(input.taskset.profileId, async tx => {
    const taskDefinition = await requireLearningRelease(tx, "definition", ModelProjectVersionedRefSchema.parse(input.taskset.metadata.taskDefinition));
    const rewardBinding = await requireLearningRelease(tx, "binding", ModelProjectVersionedRefSchema.parse(input.taskset.metadata.rewardBinding));
    const rewards = [...new Map((await Promise.all(rewardBinding.sources.map(source => requireLearningRelease(tx, "reward", source.reward))))
      .map(reward => [`${reward.id}:${reward.revision}:${reward.contentHash}`, reward])).values()];
    const assets = new Map<string, LearningTextAsset>();
    const addAsset = async (id: string) => {
      if (!assets.has(id)) assets.set(id, await requireLearningResource(tx, "asset", id, 1));
    };
    for (const reward of rewards) {
      const implementation = reward.implementation;
      for (const ref of [
        ...reward.assets,
        ...("verifierRef" in implementation ? [implementation.verifierRef] : []),
        ...("rubricRef" in implementation ? [implementation.rubricRef] : []),
        ...("inputContract" in implementation ? [implementation.inputContract] : []),
      ]) await addAsset(ref.id);
    }
    const environment = input.executionResources.environment;
    for (const ref of [environment.actionSchemaRef, environment.observationSchemaRef, environment.stateSchemaRef]) if (ref) await addAsset(ref.id);
    for (const task of input.release.tasks) if (task.privilegedContextRef) await addAsset(task.privilegedContextRef);
    let execution: ModelTasksetPackage["execution"];
    if (input.release.environment.entrypoint === "openpond.javascript-environment.v1") {
      const asset = await requireLearningResource(tx, "asset", modelStarterExecutionAssetId(input.release), 1);
      execution = ModelStarterExecutionSchema.parse(JSON.parse(verifyLearningTextAsset(asset, asset.asset)));
      await addAsset(execution.javascript.module.id);
    }
    return validateModelTasksetPackage({
      taskset: input.release,
      taskDefinition,
      rewardBinding,
      rewards,
      assets: [...assets.values()],
      executionResources: input.executionResources,
      ...(execution ? { execution } : {}),
    });
  });
}
