import { expect, test } from "vitest";
import { TrainingRecipeSchema } from "@openpond/contracts";
import { managedRftRecipe, rftTasksetFixture } from "./helpers/managed-training-fixtures.js";
import { withAuthoritativeRecipeHashes } from "../apps/server/src/training/training-service-helpers.js";
import { trainingRecipe } from "../apps/web/src/components/training/training-start-recipe.js";

// Managed submission requires a concrete GPU cap in the already-approved
// recipe; filling it only at transport time would change that contract.
test("resolves an omitted GRPO GPU cap before approval and preserves explicit limits", () => {
  const taskset = rftTasksetFixture();
  const recipe = managedRftRecipe();
  const prepare = (wallTimeMs: number, maxGpuSeconds?: number) => {
    const resolved = TrainingRecipeSchema.parse(withAuthoritativeRecipeHashes(taskset, {
      ...recipe,
      resourceLimits: { ...recipe.resourceLimits, wallTimeMs, maxGpuSeconds },
    }));
    if (resolved.method !== "grpo") throw new Error("Expected GRPO recipe");
    return resolved.resourceLimits.maxGpuSeconds;
  };
  expect(prepare(1_800_000)).toBe(1_800);
  expect(prepare(24 * 60 * 60 * 1_000)).toBe(10_800);
  expect(prepare(1_800_000, 600)).toBe(600);
  expect(() => prepare(1_800_000, 0)).toThrow();
});

// Reopening or editing visible fields must not expand saved limits or replace unexposed optimizer settings.
test("retains saved GRPO resource ceilings when the editor rebuilds a recipe", () => {
  const saved = managedRftRecipe();
  saved.resourceLimits = { ...saved.resourceLimits, wallTimeMs: 900_000, maxGpuSeconds: 600, maxRollouts: 8 };
  saved.optimizer.iterations = 3;
  saved.rollout.seed = 91;
  const result = trainingRecipe({ method: "grpo", taskset: rftTasksetFixture(), destinationId: "openpond_managed",
    baseModelId: saved.baseModel.id, savedRecipe: saved, maxSteps: 2, sequenceLength: 1024, rank: 16,
    learningRate: 0.00001, klBeta: null, rolloutGroupSize: 4, rolloutConcurrency: 4, rolloutMaxOutputTokens: 128,
    trainingExamples: 8, rftLossMethod: "grpo" });
  if (result.method !== "grpo") throw new Error("Expected GRPO recipe");
  expect(result.resourceLimits).toEqual(saved.resourceLimits);
  expect(result.optimizer.iterations).toBe(3);
  expect(result.rollout.seed).toBe(91);
  expect(result.dataset.maxPromptTokens).toBe(1024);
  expect(result.rollout.maxOutputTokens).toBe(128);
});
