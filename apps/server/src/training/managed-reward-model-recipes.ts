import {
  RewardModelRecipeSchema,
  type RewardModelRecipe,
} from "@openpond/contracts";

import type { ManagedRewardModelBase } from "./reward-model-launch-input.js";

export const MANAGED_REWARD_MODEL_PROFILE: ManagedRewardModelBase = {
  source: "huggingface",
  repoId: "Qwen/Qwen3-0.6B",
  revision: "c1899de289a04d12100db370d81485cdf75e47ca",
  configHash: "660db3b73d788119c04535e48cf9be5f55bc3100841a718637ae695b442f27dd",
  tokenizerHash: "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
  licenseId: "apache-2.0",
  gated: false,
};

const MANAGED_REWARD_PROCESSOR = {
  id: "qwen3-tokenizer-c1899de2",
  contentHash: "d5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101",
};

export function managedSyntheticRewardSmokeRecipe(input: {
  tasksetRelease: { id: string; contentHash: string };
  preferenceDatasetRelease: { id: string; contentHash: string };
  serialization?:
    | "scenario_input_and_candidate_json_v1"
    | "support_visible_trajectory_v1";
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
    input: {
      kind: "structured_text",
      serialization: input.serialization ?? "scenario_input_and_candidate_json_v1",
      maxCharacters:
        input.serialization === "support_visible_trajectory_v1"
          ? 96_000
          : 32_000,
    },
    lora: {
      rank: 4,
      alpha: 8,
      dropout: 0,
      targetModules: ["q_proj", "k_proj", "v_proj", "o_proj"],
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
      maxInputCharacters:
        input.serialization === "support_visible_trajectory_v1"
          ? 96_000
          : 32_000,
      maximumSpendUsd: 2,
    },
  });
}
