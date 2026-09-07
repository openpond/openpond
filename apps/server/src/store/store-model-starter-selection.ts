import { assertLearningContentHash, learningRef, learningResourceSchemas, sameLearningRef, type LearningResourceFor } from "@openpond/evals/learning";
import { validateModelStarterCreation } from "openpond-sdk/model-starters";
import { canonicalJson } from "openpond-sdk/training";
import type { ModelStarterCommitInput } from "./store-model-starters.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

/** Resolve the selection from owner-held resources, before building any files.
 * Callers cannot inject replacement code through the creation request. */
export function resolveModelStarterSelection(db: OpenPondSqliteConnection, input: ModelStarterCommitInput): ModelStarterCommitInput {
  const { request, resolved } = validateModelStarterCreation(input.request, input.package);
  const selected = request.rewardBindingRef;
  if (!selected || sameLearningRef(selected, learningRef(resolved.rewardBinding))) return input;
  function read<K extends "asset" | "reward" | "binding">(kind: K, ref: { id: string; revision: number; contentHash?: string }): LearningResourceFor<K> {
    const row = db.get<{ payload: string }>("SELECT payload FROM learning_revisions WHERE scope = ? AND kind = ? AND id = ? AND revision = ?", [request.profileId, kind, ref.id, ref.revision]);
    if (!row) throw new Error(`The selected starter ${kind} is unavailable in this Profile.`);
    const resource = learningResourceSchemas[kind].parse(JSON.parse(row.payload));
    assertLearningContentHash(resource);
    if (ref.contentHash && ref.contentHash !== resource.contentHash) throw new Error("The selected starter Reward differs from its immutable reference.");
    return resource as LearningResourceFor<K>;
  }
  const rewardBinding = read("binding", selected);
  const rewards = [...new Map(rewardBinding.sources.map(source => [canonicalJson(source.reward), read("reward", source.reward)])).values()];
  const assets = new Map(resolved.assets.map(asset => [asset.id, asset]));
  for (const reward of rewards) {
    const implementation = reward.implementation;
    for (const reference of [...reward.assets, ...("verifierRef" in implementation ? [implementation.verifierRef] : []), ...("rubricRef" in implementation ? [implementation.rubricRef] : []), ...("inputContract" in implementation ? [implementation.inputContract] : [])]) {
      if (!assets.has(reference.id)) assets.set(reference.id, read("asset", { id: reference.id, revision: 1 }));
    }
  }
  return { ...input, rewardSelection: { rewardBinding, rewards, assets: [...assets.values()] } };
}
