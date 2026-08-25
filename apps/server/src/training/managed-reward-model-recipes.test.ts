import { describe, expect, test } from "vitest";

import {
  MANAGED_REWARD_MODEL_PROFILE,
  managedSyntheticRewardSmokeRecipe,
} from "./managed-reward-model-recipes.js";

describe("managed Reward Model recipes", () => {
  test("server-assembles the bounded smoke recipe from immutable run inputs", () => {
    const recipe = managedSyntheticRewardSmokeRecipe({
      tasksetRelease: { id: "taskset-general", contentHash: "a".repeat(64) },
      preferenceDatasetRelease: { id: "preferences-general", contentHash: "b".repeat(64) },
    });

    expect(recipe.tasksetRelease.id).toBe("taskset-general");
    expect(recipe.preferenceDatasetRelease.id).toBe("preferences-general");
    expect(recipe.baseModel.id).toBe(MANAGED_REWARD_MODEL_PROFILE.repoId);
    expect(recipe.baseModel.revision).toBe(MANAGED_REWARD_MODEL_PROFILE.revision);
    expect(recipe.runScope).toBe("synthetic_smoke");
    expect(recipe.optimizer.maxSteps).toBe(1);
    expect(recipe.resourceLimits.maximumSpendUsd).toBe(2);
    expect(JSON.stringify(recipe).toLowerCase()).not.toContain("nft");
  });
});
