import { z } from "zod";
import { createEnvironmentRelease, createVerifierSetRelease, verifyEnvironmentRelease, verifyVerifierSetRelease } from "@openpond/evals";
import { LearningTextAssetSchema, TaskDefinitionSchema, assertLearningContentHash, learningRef, sameLearningRef, sealLearningContent, verifyLearningTextAsset } from "@openpond/evals/learning";
import { RewardBindingSchema, RewardReleaseSchema, compileBoundGraders } from "@openpond/evals/rewards";
import { TasksetReleaseSchema, assertTasksetRelease } from "@openpond/evals/tasksets";
import { validateTaskValue } from "@openpond/evals/task-schema";

import { ModelProjectVersionedRefSchema } from "./model-projects.js";
import { ModelStarterExecutionSchema, validateModelStarterExecution } from "./model-starter-execution.js";
import { ModelTasksetExecutionResourcesSchema } from "./model-taskset-resources.js";

const OwnerSchema = z.object({ scopeId: z.string().trim().min(1).max(500), modelId: z.string().trim().min(1).max(500) }).strict();
export const ModelTasksetDerivationSchema = z.object({
  schemaVersion: z.literal("openpond.modelTasksetDerivation.v1"),
  owner: OwnerSchema,
  root: ModelProjectVersionedRefSchema,
  parent: ModelProjectVersionedRefSchema,
}).strict();

/** Immutable executable resources, independent of a catalog listing. */
export const ModelTasksetPackageSchema = z.object({
  taskset: TasksetReleaseSchema,
  taskDefinition: TaskDefinitionSchema,
  rewardBinding: RewardBindingSchema,
  rewards: z.array(RewardReleaseSchema).min(1).max(100),
  assets: z.array(LearningTextAssetSchema).max(1_000),
  executionResources: ModelTasksetExecutionResourcesSchema.optional(),
  execution: ModelStarterExecutionSchema.optional(),
}).strict();
export type ModelTasksetPackage = z.infer<typeof ModelTasksetPackageSchema>;

const same = (left: unknown, right: unknown) => sealLearningContent({ value: left }).contentHash === sealLearningContent({ value: right }).contentHash;
const identity = (owner: z.infer<typeof OwnerSchema>, root: z.infer<typeof ModelProjectVersionedRefSchema>) => `model-taskset-${sealLearningContent({ owner, root }).contentHash}`;

/** Hosts authorize the source and owner, upload immutable files, then commit
 * this result together with the model CAS and operation receipt. This pure
 * compiler neither allocates a new identity on retry nor changes a consumer. */
export function deriveModelTaskset(input: {
  owner: z.input<typeof OwnerSchema>;
  source: ModelTasksetPackage;
  rewardBinding: z.infer<typeof RewardBindingSchema>;
  rewards: z.infer<typeof RewardReleaseSchema>[];
  assets: z.infer<typeof LearningTextAssetSchema>[];
}): ModelTasksetPackage {
  const owner = OwnerSchema.parse(input.owner);
  const source = validateModelTasksetPackage(input.source);
  const previous = source.taskset.metadata.modelTasksetDerivation === undefined ? null : ModelTasksetDerivationSchema.parse(source.taskset.metadata.modelTasksetDerivation);
  if (previous && source.taskset.id !== identity(previous.owner, previous.root)) throw new Error("Derived Taskset identity differs from its ownership lineage.");
  const owned = previous && same(previous.owner, owner);
  const root = owned ? previous.root : learningRef(source.taskset);
  const id = owned ? source.taskset.id : identity(owner, root);
  const revision = owned ? source.taskset.revision + 1 : 1;
  const rewardBinding = RewardBindingSchema.parse(input.rewardBinding);
  const rewards = input.rewards.map(reward => RewardReleaseSchema.parse(reward));
  const graders = compileBoundGraders(rewardBinding, rewards);
  if (rewardBinding.recipeRef) throw new Error("Resolve the Reward recipe into one standalone binding before deriving a Taskset.");
  const policy = { ...source.taskset.policy, hiddenGraderRefs: graders.filter(grader => grader.privileged).map(grader => grader.id) };
  const previousResources = source.executionResources ?? source.execution;
  const environment = previousResources?.environment ?? createEnvironmentRelease({
    schemaVersion: "openpond.environmentRelease.v1", id: `${id}-environment`, revision: 1,
    contract: source.taskset.environment, actionSchemaRef: null, observationSchemaRef: null, stateSchemaRef: null,
    artifactCollection: { maxArtifacts: 100_000, maxTotalBytes: 250_000_000 }, adapterConformanceHashes: {}, metadata: {},
  });
  const verifierSet = createVerifierSetRelease({
    schemaVersion: "openpond.verifierSetRelease.v1", id: `${id}-verifiers`, revision, graders,
    isolation: previousResources?.verifierSet.isolation ?? { processBoundary: "isolated_process", networkPolicy: "none", defaultTimeoutMs: Math.min(source.taskset.environment.defaultTimeoutMs, 300_000) },
    calibrationReceiptRefs: [], metadata: previousResources ? { sourceVerifierSet: learningRef(previousResources.verifierSet) } : {},
  });
  const executionResources = { environment, verifierSet };
  const execution = source.execution ? { ...source.execution, verifierSet } : undefined;
  const { contentHash: _taskHash, ...taskContent } = source.taskset;
  const { contentHash: _definitionHash, ...definitionContent } = source.taskDefinition;
  const taskExecution = { ...definitionContent.execution, policy, environmentRelease: { id: environment.id, contentHash: environment.contentHash }, verifierSetRelease: { id: verifierSet.id, contentHash: verifierSet.contentHash } };
  const taskDefinition = TaskDefinitionSchema.parse(sealLearningContent({ ...definitionContent, id: `${id}-definition`, revision, rewardBinding: learningRef(rewardBinding), execution: taskExecution }));
  const authoring = source.taskset.metadata.starterAuthoring;
  const graderFixtures = authoring && typeof authoring === "object" && !Array.isArray(authoring) && "graderFixtures" in authoring ? authoring.graderFixtures : undefined;
  // Keep provenance through exact lineage. Source package qualifications and
  // privacy attestations describe different bytes and must not be copied.
  const taskset = TasksetReleaseSchema.parse(sealLearningContent({
    ...taskContent, ...taskExecution, id, revision, graders,
    metadata: {
      starter: { taskDefinition: learningRef(taskDefinition), rewardBinding: learningRef(rewardBinding) },
      rewardExecution: { binding: rewardBinding, rewards },
      ...(graderFixtures === undefined ? {} : { starterAuthoring: { graderFixtures } }),
      modelTasksetDerivation: { schemaVersion: "openpond.modelTasksetDerivation.v1", owner, root, parent: learningRef(source.taskset) },
    },
  }));
  return validateModelTasksetPackage({ taskset, taskDefinition, rewardBinding, rewards, assets: input.assets, executionResources, ...(execution ? { execution } : {}) });
}

export function validateModelTasksetPackage(value: unknown): ModelTasksetPackage {
  const result = ModelTasksetPackageSchema.parse(value);
  const { taskset, taskDefinition, rewardBinding, rewards, assets, execution } = result;
  for (const resource of [taskset, taskDefinition, rewardBinding, ...rewards, ...assets]) assertLearningContentHash(resource);
  assertTasksetRelease(taskset);
  if (rewardBinding.recipeRef) throw new Error("Resolve the Reward recipe into one standalone binding before deriving a Taskset.");
  if (!sameLearningRef(taskDefinition.rewardBinding, learningRef(rewardBinding))) throw new Error("Taskset definition differs from its Reward binding.");
  const { policy, environment, environmentRelease, tools, capabilities, verifierSetRelease } = taskset;
  if (!same(taskDefinition.execution, { policy, environment, ...(environmentRelease ? { environmentRelease } : {}), tools, capabilities, ...(verifierSetRelease ? { verifierSetRelease } : {}) })) throw new Error("Taskset definition differs from its execution resources.");
  if (!same(taskset.graders, compileBoundGraders(rewardBinding, rewards))) throw new Error("Taskset graders differ from its Reward binding.");
  if (taskset.metadata.starter !== undefined) {
    const metadata = z.object({ taskDefinition: ModelProjectVersionedRefSchema, rewardBinding: ModelProjectVersionedRefSchema }).passthrough().parse(taskset.metadata.starter);
    if (!sameLearningRef(metadata.taskDefinition, learningRef(taskDefinition)) || !sameLearningRef(metadata.rewardBinding, learningRef(rewardBinding))) throw new Error("Taskset metadata differs from its immutable grading resources.");
  }
  if (taskset.metadata.rewardExecution !== undefined && !same(taskset.metadata.rewardExecution, { binding: rewardBinding, rewards })) throw new Error("Taskset embedded Rewards differ from its immutable grading resources.");
  if (taskset.metadata.rewardBinding !== undefined && !sameLearningRef(ModelProjectVersionedRefSchema.parse(taskset.metadata.rewardBinding), learningRef(rewardBinding))) throw new Error("Taskset Reward reference differs from its immutable grading resources.");
  const resources = result.executionResources ?? execution;
  if (taskset.environmentRelease && !resources) throw new Error("Deriving a Taskset requires its pinned execution resources.");
  if (resources && (!verifyEnvironmentRelease(resources.environment) || !verifyVerifierSetRelease(resources.verifierSet) ||
      !same(taskset.environmentRelease, { id: resources.environment.id, contentHash: resources.environment.contentHash }) ||
      !same(taskset.verifierSetRelease, { id: resources.verifierSet.id, contentHash: resources.verifierSet.contentHash }) ||
      !same(taskset.environment, resources.environment.contract) || !same(taskset.graders, resources.verifierSet.graders))) throw new Error("Taskset differs from its pinned execution resources.");
  validateModelStarterExecution(execution, taskset, assets);
  if (new Set(assets.map(asset => asset.id)).size !== assets.length) throw new Error("Taskset asset identities must be unique.");
  for (const asset of assets) verifyLearningTextAsset(asset, asset.asset);
  for (const reference of resources ? [resources.environment.actionSchemaRef, resources.environment.observationSchemaRef, resources.environment.stateSchemaRef] : []) {
    if (!reference) continue;
    const asset = assets.find(asset => asset.id === reference.id);
    if (!asset) throw new Error(`Taskset environment asset is missing: ${reference.id}.`);
    verifyLearningTextAsset(asset, reference);
  }
  for (const task of taskset.tasks) {
    if (taskDefinition.requiredOutputs && !same(task.requiredOutputs, taskDefinition.requiredOutputs)) throw new Error(`Taskset outputs differ from its reviewed definition: ${task.id}.`);
    if (task.policyVisibleContext.instructions !== taskDefinition.instructions || !validateTaskValue(taskDefinition.inputSchema, task.input).valid ||
        (task.expectedOutput !== null && !validateTaskValue(taskDefinition.outputSchema, task.expectedOutput).valid)) throw new Error(`Taskset task differs from its declared format: ${task.id}.`);
    if (task.privilegedContextRef && !assets.some(asset => asset.id === task.privilegedContextRef && asset.asset.visibility === "host_private")) throw new Error(`Taskset private context is missing: ${task.id}.`);
  }
  for (const reward of rewards) {
    const implementation = reward.implementation;
    const references = [...reward.assets, ...("verifierRef" in implementation ? [implementation.verifierRef] : []), ...("rubricRef" in implementation ? [implementation.rubricRef] : []), ...("inputContract" in implementation ? [implementation.inputContract] : [])];
    for (const reference of references) {
      const asset = assets.find(asset => asset.id === reference.id);
      if (!asset || reference.visibility === "policy") throw new Error(`Taskset Reward requires its private asset: ${reference.id}.`);
      verifyLearningTextAsset(asset, reference);
    }
  }
  return result;
}
