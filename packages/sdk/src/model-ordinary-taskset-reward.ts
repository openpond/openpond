import { LearningTextAssetSchema, TaskDefinitionSchema, learningRef, sealLearningContent, type LearningTextAsset } from "@openpond/evals/learning";
import type { RewardBinding, RewardRelease } from "@openpond/evals/rewards";
import { compileModelTasksetReward } from "./model-taskset-derivation.js";
import { createTasksetPackage, resolveTasksetPackageInstructions, validateTasksetPackage, type TasksetPackage } from "./taskset-package-contracts.js";
import { decodeTasksetPackageFile } from "./taskset-package-files.js";
import { resolveTasksetPackageExecution } from "./taskset-package-execution.js";

/** Bind a saved Reward without rewriting task envelopes, private context, tools
 * or arbitrary binary files. Compatibility is admission, not qualification. */
export function bindOrdinaryModelTasksetReward(input: {
  owner: { scopeId: string; modelId: string };
  source: TasksetPackage;
  rewardBinding: RewardBinding;
  rewards: RewardRelease[];
  assets: LearningTextAsset[];
}): TasksetPackage {
  const source = validateTasksetPackage(input.source);
  if (source.modelResources || source.learningResources) throw new Error("Binding an ordinary Reward requires an ordinary source package.");
  const instructions = resolveTasksetPackageInstructions(source);
  if (!instructions.trim()) throw new Error("Add collection instructions before selecting a saved Reward.");
  const assets = new Map<string, LearningTextAsset>();
  const execution = resolveTasksetPackageExecution(source);
  for (const asset of execution?.assets ?? []) assets.set(asset.id, asset);
  const contextIds = new Set([
    ...source.taskset.tasks.flatMap(task => task.privilegedContextRef ? [task.privilegedContextRef] : []),
    ...[source.environment.actionSchemaRef, source.environment.observationSchemaRef, source.environment.stateSchemaRef].flatMap(ref => ref ? [ref.id] : []),
  ]);
  for (const id of contextIds) {
    if (assets.has(id)) continue;
    const file = source.files.find(file => file.asset.id === id);
    if (!file) throw new Error(`Source Taskset context is missing: ${id}.`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decodeTasksetPackageFile(file));
    assets.set(id, LearningTextAssetSchema.parse(sealLearningContent({ schemaVersion: "openpond.learningTextAsset.v1", id, revision: 1, asset: file.asset, text })));
  }
  for (const asset of input.assets) {
    const original = source.files.find(file => file.asset.id === asset.id);
    if (original && sealLearningContent({ asset: original.asset }).contentHash !== sealLearningContent({ asset: asset.asset }).contentHash) throw new Error(`Selected Reward conflicts with a source asset: ${asset.id}.`);
    assets.set(asset.id, asset);
  }
  const { policy, environment, environmentRelease, tools, capabilities, verifierSetRelease } = source.taskset;
  const taskDefinition = TaskDefinitionSchema.parse(sealLearningContent({
    schemaVersion: "openpond.taskDefinition.v1", id: `${source.taskset.id}-definition`, revision: 1,
    name: source.taskset.id, description: "", instructions, category: "custom", familyNamespace: source.taskset.id,
    inputSchema: { type: "object" }, outputSchema: { type: "object" },
    rewardBinding: learningRef(input.rewardBinding), harness: null,
    execution: { policy, environment, environmentRelease, tools, capabilities, verifierSetRelease },
  }));
  const derived = compileModelTasksetReward({ ...input, assets: [...assets.values()], source: {
    taskset: source.taskset, taskDefinition, instructionMode: "per_task",
    executionResources: { environment: source.environment, verifierSet: source.verifierSet },
    ...(execution ? { execution: execution.execution } : {}),
  } });
  const files = new Map(source.files.map(file => [file.asset.id, file]));
  for (const asset of derived.assets) {
    let raw = "";
    for (const byte of new TextEncoder().encode(asset.text)) raw += String.fromCharCode(byte);
    files.set(asset.id, { asset: asset.asset, base64: btoa(raw) });
  }
  const { taskset, executionResources, ...modelResources } = derived;
  return createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset, ...executionResources!, modelResources, files: [...files.values()] });
}
