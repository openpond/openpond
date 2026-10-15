import { contentHash } from "@openpond/harness";
import { LearningTextAssetSchema, TaskDefinitionSchema, learningRef, sameLearningRef, sealLearningContent } from "@openpond/evals/learning";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { ModelTasksetDerivationSchema, compileModelTasksetReward } from "./model-taskset-derivation.js";
import type { ModelTasksetDraftPreparation } from "./model-taskset-authoring-contracts.js";
import { createTasksetPackage, decodeTasksetPackageFile, resolveTasksetPackageInstructions, validateTasksetPackage, type TasksetPackage } from "./taskset-package-contracts.js";
import { createTasksetPackageExecutionFile, resolveTasksetPackageExecution } from "./taskset-package-execution.js";
import { isManagedTasksetDraftFilePath } from "./taskset-draft-files.js";
import { ModelStarterExecutionSchema } from "./model-starter-execution.js";

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
  const referencedIds = new Set([...requiredIds, ...edited.taskset.tasks.flatMap(task => [
    ...task.artifactRefs.map(asset => asset.id), ...(task.requiredOutputs ?? []).flatMap(output => output.schemaRef ? [output.schemaRef.id] : []),
  ])]);
  const files = retainSourceFileIdentities(source, edited, referencedIds);
  for (const id of requiredIds) {
    const file = files.find(file => file.asset.id === id);
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
  return createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset: published, ...executionResources!, modelResources, files });
}

function retainSourceFileIdentities(source: TasksetPackage, edited: TasksetPackage, referencedIds: Set<string>) {
  let files = edited.files;
  const sourceById = new Map(source.files.map(file => [file.asset.id, { file, assetHash: contentHash(file.asset) }]));
  const isSourceFile = (file: TasksetPackage["files"][number]) => {
    const previous = sourceById.get(file.asset.id);
    return previous !== undefined && previous.file.base64 === file.base64 && previous.assetHash === contentHash(file.asset);
  };
  // Reserved authoring manifests describe the edited document. Historical
  // source files at those paths live in read-only aliases, and must keep their
  // original immutable identity rather than inherit generated manifest bytes.
  const knownAliases = source.files.filter(file => isManagedTasksetDraftFilePath(file.asset.path)).map(original => {
    const id = `source-artifact-${contentHash({ packageHash: source.contentHash, assetId: original.asset.id })}`;
    return { original, asset: { ...original.asset, id,
      path: `source-artifacts/${source.contentHash}/${contentHash(original.asset.path)}/${original.asset.path.split("/").at(-1)!}` } };
  });
  for (const { original, asset } of knownAliases) {
    const candidates = knownAliases.filter(candidate => contentHash({ ...candidate.original.asset, id: original.asset.id }) === contentHash(original.asset));
    const own = edited.files.find(file => file.asset.id === asset.id);
    const alias = own ?? candidates.flatMap(candidate => edited.files.filter(file => contentHash(file.asset) === contentHash(candidate.asset)))[0];
    if (!alias || alias.base64 !== original.base64 || !candidates.some(candidate => contentHash(candidate.asset) === contentHash(alias.asset))) {
      throw new Error(`Retained Taskset source artifact differs from its original bytes: ${original.asset.id}.`);
    }
    const collisions = files.filter(file => file.asset.path === original.asset.path || file.asset.id === original.asset.id);
    if (collisions.some(file => file.asset.path !== original.asset.path || file.asset.id !== original.asset.id
      && file.asset.id !== `taskset-file-${contentHash(original.asset.path)}`
      && !isSourceFile(file))) {
      throw new Error(`Retained Taskset source artifact conflicts with an authored file: ${original.asset.id}.`);
    }
    files = [...files.filter(file => file.asset.id !== asset.id && file.asset.id !== original.asset.id
      && (!collisions.includes(file) || isSourceFile(file))), original];
  }
  // One on-disk file may have multiple historical immutable identities. The
  // authored inventory can collapse those aliases, but cannot change their
  // bytes or resurrect a missing asset used by current execution.
  for (const original of source.files.filter(file => !files.some(current => current.asset.id === file.asset.id))) {
    // The execution owner regenerates its declaration for the new release.
    // Only its exact canonical envelope qualifies for this exception.
    if (original.asset.path === "environment/execution.json") {
      const execution = ModelStarterExecutionSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeTasksetPackageFile(original))));
      if (execution.success && contentHash(createTasksetPackageExecutionFile(execution.data)) === contentHash(original)) continue;
    }
    const candidates = files.filter(file => file.asset.path === original.asset.path);
    const sameEnvelope = (file: typeof original) => contentHash({ ...file.asset, id: original.asset.id }) === contentHash(original.asset)
      && file.base64 === original.base64;
    if (referencedIds.has(original.asset.id) || !candidates.length || candidates.some(file => !sameEnvelope(file))) {
      throw new Error(`Retained Taskset source alias differs from its original bytes: ${original.asset.id}.`);
    }
    files = [...files, original];
  }
  return files;
}
