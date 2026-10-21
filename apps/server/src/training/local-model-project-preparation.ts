import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { learningRef, LearningTextAssetSchema, verifyLearningTextAsset } from "@openpond/evals/learning";
import { RewardBindingSchema, RewardReleaseSchema } from "@openpond/evals/rewards";
import { createModelProjectSaveRequest, ModelProjectEditableSchema, ModelProjectSaveRequestSchema } from "openpond-sdk/model-projects";
import { bindOrdinaryModelTasksetReward, prepareImportedTasksetPackage, TasksetPackageSchema, validateTasksetPackage, type TasksetPackage } from "openpond-sdk/taskset-packages";
import { TasksetSchema, type Taskset } from "@openpond/contracts";
import { retainModelTasksetInputReview } from "./model-taskset-review-projection.js";

const id = z.string().trim().min(1).max(500);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const LocalModelProjectPreparationInputSchema = z.object({
  schemaVersion: z.literal("openpond.localModelProjectPreparationInput.v1"),
  source: z.object({ ownerId: id, datasetId: id, revision: z.number().int().positive(), workspaceHash: hash, packageHash: hash }).strict(),
  project: ModelProjectEditableSchema,
  rewardBinding: RewardBindingSchema,
  rewards: z.array(RewardReleaseSchema).min(1).max(100),
  assets: z.array(LearningTextAssetSchema).max(100),
}).strict();
export const LocalModelProjectPreparationSchema = z.object({
  schemaVersion: z.literal("openpond.localModelProjectPreparation.v1"),
  request: LocalModelProjectPreparationInputSchema,
  package: TasksetPackageSchema,
  taskset: TasksetSchema,
  saveRequest: ModelProjectSaveRequestSchema,
  contentHash: hash,
}).strict();
export type LocalModelProjectPreparationInput = z.infer<typeof LocalModelProjectPreparationInputSchema>;
export type LocalModelProjectPreparation = z.infer<typeof LocalModelProjectPreparationSchema>;

/** Pure compilation. Publication, qualification and execution have separate owners. */
export async function prepareLocalModelProject(input: {
  request: unknown; source: TasksetPackage; reviewedTaskset: Taskset; createdAt: string; name: string;
}): Promise<LocalModelProjectPreparation> {
  const request = LocalModelProjectPreparationInputSchema.parse(input.request);
  const source = validateTasksetPackage(input.source);
  if (source.contentHash !== request.source.packageHash) throw new Error("Dataset package changed since preparation was requested.");
  if (request.project.trainingSetup.tasksetRef || request.project.trainingSetup.tasksetRelease || request.project.trainingSetup.evaluationTasksetRef
    || request.project.trainingSetup.rewardBindingRef || request.project.trainingSetup.harnessRelease) {
    throw new Error("Preparation selects its Taskset and Reward from the pinned source; omit preselected Taskset, Reward and Harness references.");
  }
  if (!request.project.trainingSetup.recipe || !request.project.trainingSetup.baseModel) throw new Error("Preparation requires an explicit pinned base model and complete recipe.");
  const base = request.project.trainingSetup.baseModel;
  const recipe = request.project.trainingSetup.recipe;
  const recipeBase = recipe.baseModel as Record<string, unknown> | undefined;
  if (!base.revision || !base.tokenizerRevision || !base.chatTemplateHash || !recipeBase
    || recipeBase.id !== base.modelId || recipeBase.revision !== base.revision || recipeBase.tokenizerRevision !== base.tokenizerRevision
    || recipeBase.chatTemplateHash !== base.chatTemplateHash || recipe.method !== request.project.trainingSetup.method) {
    throw new Error("Project and recipe must select the same pinned base model and training method.");
  }
  if (!source.taskset.tasks.some(task => task.split === "train") || !source.taskset.tasks.some(task => task.split === "validation" || task.split === "frozen_eval")) {
    throw new Error("Preparation requires existing training and held-out validation tasks; it never changes splits.");
  }
  const selected = new Set(request.rewardBinding.sources.map(source => contentHash(source.reward)));
  if (new Set(request.rewards.map(reward => contentHash(learningRef(reward)))).size !== request.rewards.length
    || request.rewards.some(reward => !selected.has(contentHash(learningRef(reward))))) throw new Error("Preparation Reward closure contains unexpected or duplicate releases.");
  const references = request.rewards.flatMap(reward => [...reward.assets,
    ...("verifierRef" in reward.implementation ? [reward.implementation.verifierRef] : []),
    ...("rubricRef" in reward.implementation ? [reward.implementation.rubricRef] : []),
    ...("inputContract" in reward.implementation ? [reward.implementation.inputContract] : [])]);
  const expected = new Set(references.map(reference => reference.id));
  if (new Set(request.assets.map(asset => asset.id)).size !== request.assets.length
    || request.assets.some(asset => !expected.has(asset.id))) throw new Error("Preparation Reward closure contains unexpected or duplicate assets.");
  for (const reference of references) {
    const asset = request.assets.find(asset => asset.id === reference.id);
    if (!asset || reference.visibility !== "verifier") throw new Error("Preparation requires its exact private verifier asset closure.");
    verifyLearningTextAsset(asset, reference);
  }
  for (const role of ["training", "evaluation"] as const) {
    if (!request.rewardBinding.sources.some(source => source.role === role && source.weight > 0)) throw new Error(`Preparation requires a positively weighted ${role} Reward source.`);
  }
  const value = bindOrdinaryModelTasksetReward({
    owner: { scopeId: request.project.profileId, modelId: request.project.id }, source,
    rewardBinding: request.rewardBinding, rewards: request.rewards, assets: request.assets,
  });
  // The managed bundle requires one immutable file per private verifier path.
  const verifierAssets = value.modelResources!.assets.filter(asset => request.assets.some(selected => selected.id === asset.id));
  if (new Set(verifierAssets.map(asset => asset.asset.path)).size !== verifierAssets.length
    || verifierAssets.some(asset => asset.asset.visibility !== "verifier")) throw new Error("Preparation requires distinct private verifier paths with verifier visibility.");
  const prepared = prepareImportedTasksetPackage({ package: value, profileId: request.project.profileId, name: input.name, createdAt: input.createdAt });
  // This path compiles the pinned, owner-local Dataset. Keep its existing
  // input review; generic downloaded packages still default to pending.
  prepared.taskset = retainModelTasksetInputReview(prepared.taskset, input.reviewedTaskset, source);
  const ref = learningRef(prepared.taskset);
  const saveRequest = await createModelProjectSaveRequest({ ...request.project, trainingSetup: {
    ...request.project.trainingSetup, tasksetRef: ref,
    evaluationTasksetRef: prepared.taskset.tasks.some(task => task.split === "validation" || task.split === "frozen_eval") ? ref : null,
    rewardBindingRef: learningRef(request.rewardBinding),
  } }, 0);
  const content = { schemaVersion: "openpond.localModelProjectPreparation.v1" as const, request, package: value, taskset: prepared.taskset, saveRequest };
  return LocalModelProjectPreparationSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function parseLocalModelProjectPreparation(value: unknown): LocalModelProjectPreparation {
  const receipt = LocalModelProjectPreparationSchema.parse(value);
  const { contentHash: hash, ...content } = receipt;
  if (contentHash(content) !== hash) throw new Error("Project preparation receipt content hash changed.");
  return receipt;
}
