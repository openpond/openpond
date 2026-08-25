import {
  RewardModelRecipeSchema,
  type RewardModelRecipe,
} from "@openpond/contracts";

import type { ManagedRewardModelBase } from "./reward-model-launch-input.js";

export const MANAGED_REWARD_MODEL_PROFILE: ManagedRewardModelBase = {
  source: "huggingface",
  repoId: "google/siglip-base-patch16-224",
  revision: "7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed",
  configHash: "cd85b3d28829722820bcb89a2cfbb4160e55fd359249a3044da724166a8d9688",
  tokenizerHash: "c6e405cb7c670d56636a9402c81023a55bc6c3c53d89cf02b92f5c5005bfe920",
  licenseId: "apache-2.0",
  gated: false,
};

const MANAGED_REWARD_PROCESSOR = {
  id: "siglip-processor-7fd15f06",
  contentHash: "d11ccb80f15d358a11bdb070e92e2d889005874b7db15823d5f10d9b2533b14a",
};

export function managedSyntheticRewardSmokeRecipe(input: {
  tasksetRelease: { id: string; contentHash: string };
  preferenceDatasetRelease: { id: string; contentHash: string };
}): RewardModelRecipe {
  return RewardModelRecipeSchema.parse({
    schemaVersion: "openpond.rewardModelRecipe.v1",
    method: "reward_model",
    parameterization: "lora_with_scalar_head",
    runScope: "synthetic_smoke",
    baseModel: {
      id: MANAGED_REWARD_MODEL_PROFILE.repoId,
      revision: MANAGED_REWARD_MODEL_PROFILE.revision,
      tokenizerRevision: MANAGED_REWARD_MODEL_PROFILE.revision,
      processorRevision: MANAGED_REWARD_MODEL_PROFILE.revision,
      chatTemplateHash: MANAGED_REWARD_MODEL_PROFILE.tokenizerHash,
    },
    tasksetRelease: input.tasksetRelease,
    preferenceDatasetRelease: input.preferenceDatasetRelease,
    processorRelease: MANAGED_REWARD_PROCESSOR,
    lora: {
      rank: 4,
      alpha: 8,
      dropout: 0,
      targetModules: ["q_proj", "k_proj", "v_proj", "out_proj"],
    },
    heads: { scalar: "pooled_hidden_state_linear", bucket: "three_class" },
    loss: {
      ranking: "bradley_terry",
      rankingWeight: 1,
      bucketWeight: 0.25,
      tieWeight: 0.1,
    },
    optimizer: {
      learningRate: 0.0001,
      maxSteps: 1,
      batchSize: 2,
      gradientAccumulationSteps: 1,
      seed: 17,
      checkpointEverySteps: 1,
    },
    resourceLimits: {
      wallTimeMs: 20 * 60 * 1_000,
      maxExamples: 8,
      maxImagePixels: 512 * 512,
      maximumSpendUsd: 2,
    },
  });
}
