import { contentHash } from "@openpond/harness";
import { LearningTextAssetSchema, TaskDefinitionSchema, learningRef, sameLearningRef, sealLearningContent } from "@openpond/evals/learning";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { ModelTasksetDerivationSchema, compileModelTasksetReward } from "./model-taskset-derivation.js";
import type { ModelTasksetDraftPreparation } from "./model-taskset-authoring-contracts.js";
import { createTasksetPackage, decodeTasksetPackageFile, resolveTasksetPackageInstructions, validateTasksetPackage, type TasksetPackage } from "./taskset-package-contracts.js";
import { resolveTasksetPackageExecution } from "./taskset-package-execution.js";

/** Task edits retain the exact saved Reward. Changing its implementation or
 * grading policy goes through Reward publication and Model selection. */
export function publishBoundModelTasksetDraftPackage(input: {
  preparation: ModelTasksetDraftPreparation; source: TasksetPackage; edited: TasksetPackage;
}): TasksetPackage {
  const source = validateTasksetPackage(input.source);
  const edited = validateTasksetPackage(input.edited);
  const prepared = input.preparation;
  if (prepared.authoringGraph !== "bound" || !source.modelResources || source.learningResources || edited.modelResources || edited.learningResources) throw new Error("Bound task editing requires its source Reward and an ordinary edited workspace.");
  if (source.contentHash !== prepared.sourcePackageHash || !sameLearningRef(learningRef(source.taskset), prepared.sourceTasksetRef)) throw new Error("Bound draft differs from its retained source package.");
  const normalizedGraders = (value: TasksetPackage) => value.taskset.graders.map(grader => grader.kind === "custom_verifier" ? { ...grader, exportName: grader.exportName ?? "verify" } : grader);
  if (contentHash(normalizedGraders(source)) !== contentHash(normalizedGraders(edited))) throw new Error("Edit the saved Reward in Rewards before changing this Taskset's graders.");
  const resources = source.modelResources;
  const assets = new Map(resources.assets.map(asset => [asset.id, asset]));
  const execution = resolveTasksetPackageExecution(edited);
  const sourceExecution = resolveTasksetPackageExecution(source);
  const environmentContent = (value: TasksetPackage["environment"]) => {
    const { id: _id, revision: _revision, contentHash: _hash, metadata, ...contract } = value;
    const { javascriptEnvironment: _javascript, ...retained } = metadata;
    return { ...contract, metadata: { ...retained, resources: retained.resources ?? [] } };
  };
  const javascriptContent = (value: typeof execution) => {
    if (!value) return null;
    const { id: _id, revision: _revision, contentHash: _hash, ...contract } = value.execution.javascript;
    return contract;
  };
  const unchangedEnvironment = contentHash(environmentContent(source.environment)) === contentHash(environmentContent(edited.environment))
    && contentHash(javascriptContent(sourceExecution)) === contentHash(javascriptContent(execution));
  const selectedEnvironment = unchangedEnvironment ? source.environment : edited.environment;
  const selectedExecution = unchangedEnvironment ? sourceExecution : execution;
  const requiredIds = new Set([
    ...resources.assets.map(asset => asset.id),
    ...edited.taskset.tasks.flatMap(task => task.privilegedContextRef ? [task.privilegedContextRef] : []),
    ...[edited.environment.actionSchemaRef, edited.environment.observationSchemaRef, edited.environment.stateSchemaRef].flatMap(ref => ref ? [ref.id] : []),
    ...(execution?.assets.map(asset => asset.id) ?? []),
  ]);
  for (const id of requiredIds) {
    const file = edited.files.find(file => file.asset.id === id);
    if (!file) throw new Error(`Bound Taskset asset is missing: ${id}.`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decodeTasksetPackageFile(file));
    assets.set(id, LearningTextAssetSchema.parse(sealLearningContent({ schemaVersion: "openpond.learningTextAsset.v1", id, revision: 1, asset: file.asset, text })));
  }
  const instructions = resolveTasksetPackageInstructions(edited);
  const { contentHash: _definitionHash, ...definitionContent } = resources.taskDefinition;
  const { policy, environment, environmentRelease, tools, capabilities, verifierSetRelease } = edited.taskset;
  const taskDefinition = TaskDefinitionSchema.parse(sealLearningContent({ ...definitionContent, instructions,
    execution: { policy, environment, environmentRelease, tools, capabilities, verifierSetRelease },
  }));
  const { contentHash: _taskHash, ...taskContent } = edited.taskset;
  const taskset = TasksetReleaseSchema.parse(sealLearningContent({ ...taskContent, tasks: edited.taskset.tasks.map(task => resources.instructionMode === "per_task" ? task
    : { ...task, policyVisibleContext: { ...task.policyVisibleContext, instructions } }) }));
  const derived = compileModelTasksetReward({ owner: prepared.lineage.owner,
    source: { ...resources, taskset: source.taskset, executionResources: { environment: source.environment, verifierSet: source.verifierSet } },
    rewardBinding: resources.rewardBinding, rewards: resources.rewards, assets: [...assets.values()],
    edits: { taskset, taskDefinition, executionResources: { environment: selectedEnvironment, verifierSet: edited.verifierSet }, ...(selectedExecution ? { execution: selectedExecution.execution } : {}) },
  });
  const lineage = ModelTasksetDerivationSchema.parse(derived.taskset.metadata.modelTasksetDerivation);
  if (derived.taskset.id !== prepared.tasksetId || derived.taskset.revision !== prepared.tasksetRevision
    || contentHash({ ...lineage, schemaVersion: prepared.lineage.schemaVersion }) !== contentHash(prepared.lineage)) throw new Error("Bound draft differs from its retained ownership lineage.");
  const { taskset: published, executionResources, ...modelResources } = derived;
  return createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset: published, ...executionResources!, modelResources, files: edited.files });
}
