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
  expect(prepare(21_600_000, 21_600)).toBe(21_600);
  expect(() => prepare(21_600_000, 21_601)).toThrow();
  expect(() => prepare(1_800_000, 0)).toThrow();

  // A reviewed cold-start allowance must survive canonical authoring and
  // the SDK's authoritative recipe binding instead of disappearing at parse.
  const coldRecipe = {
    ...recipe,
    resourceLimits: { ...recipe.resourceLimits, warmupDeadlineSeconds: 3_600 },
  };
  const resolvedCold = TrainingRecipeSchema.parse(withAuthoritativeRecipeHashes(taskset,
    TrainingRecipeSchema.parse(JSON.parse(JSON.stringify(coldRecipe)))));
  if (resolvedCold.method !== "grpo") throw new Error("Expected GRPO recipe");
  expect(resolvedCold.resourceLimits.warmupDeadlineSeconds).toBe(3_600);
  expect(resolvedCold.resourceLimits.wallTimeMs).toBe(recipe.resourceLimits.wallTimeMs);
  for (const warmupDeadlineSeconds of [0, -1, 3_601, 1.5, "3600", null]) {
    expect(() => TrainingRecipeSchema.parse({
      ...coldRecipe,
      resourceLimits: { ...coldRecipe.resourceLimits, warmupDeadlineSeconds },
    })).toThrow();
  }
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

// Selecting a smoke preset must not inherit a provider's larger paid-run defaults;
// reopening a saved larger recipe must block launch rather than keep the smoke label.
test("bounds smoke training through catalog defaults, recipe preparation, and saved settings", async () => {
  const { trainingRunDefaults, trainingSmokeIncompatibility, trainingSmokeLimits, trainingSmokeRecipe } = await import("../apps/web/src/components/training/training-run-presets.js");
  const catalogDefaults = { maxSteps: 50, rolloutGroupSize: 16, rolloutConcurrency: 8 };
  const topology = trainingRunDefaults("small_experiment", "grpo", catalogDefaults);
  const smoke = trainingSmokeLimits("grpo");
  const recipe = trainingRecipe({ method: "grpo", taskset: rftTasksetFixture(), destinationId: "openpond_managed",
    baseModelId: "Qwen/Qwen3-8B", ...topology, trainingExamples: smoke.trainingExamples,
    sequenceLength: 4096, rank: 16, learningRate: 0.00001, klBeta: 0.01, rolloutMaxOutputTokens: 4096 });
  if (recipe.method !== "grpo") throw new Error("Expected GRPO recipe");
  const admitted = TrainingRecipeSchema.parse(withAuthoritativeRecipeHashes(rftTasksetFixture(), recipe));
  if (admitted.method !== "grpo") throw new Error("Expected GRPO recipe");
  expect(admitted.dataset.maxExamples).toBe(1);
  expect(admitted.optimizer.maxSteps).toBe(1);
  expect(admitted.optimizer.iterations).toBe(2);
  expect(admitted.resourceLimits.maxRollouts).toBe(4);
  expect(admitted.rollout.concurrency).toBe(1);
  const settings = { ...topology, trainingExamples: 1, optimizerIterations: 2, maximumRollouts: 4 };
  expect(trainingSmokeIncompatibility("small_experiment", "grpo", settings)).toBeNull();
  for (const expanded of [{ maxSteps: 50 }, { trainingExamples: 16 }, { rolloutGroupSize: 16 }, { rolloutConcurrency: 8 }, { optimizerIterations: 3 }, { maximumRollouts: 8 }]) {
    expect(trainingSmokeIncompatibility("small_experiment", "grpo", { ...settings, ...expanded })).not.toBeNull();
  }
  expect(trainingRunDefaults("custom", "grpo", catalogDefaults)).toEqual(catalogDefaults);
  const existing = managedRftRecipe();
  existing.optimizer.maxSteps = 50;
  existing.resourceLimits.maxRollouts = 400;
  const converted = trainingSmokeRecipe(existing);
  expect(converted.resourceLimits).toEqual({ ...existing.resourceLimits, maxRollouts: 4 });
  expect(converted.dataset).toEqual({ ...existing.dataset, maxExamples: 1 });
  expect(converted.rollout.maxOutputTokens).toBe(existing.rollout.maxOutputTokens);
  expect(converted.optimizer.maxSteps).toBe(1);
  expect(converted.optimizer.iterations).toBe(2);
  expect(converted.policyOptimization).toBeNull();
});

// Explicit quantity edits may resize the rollout ceiling, while unrelated
// controls must retain the originally reviewed compute and time limits.
test("explicit run sizing updates rollout capacity without resetting other limits", () => {
  const saved = managedRftRecipe();
  saved.resourceLimits = { ...saved.resourceLimits, maxRollouts: 4, maxGpuSeconds: 600, wallTimeMs: 900000 };
  const recipe = trainingRecipe({ savedRecipe: saved, method: "grpo", taskset: rftTasksetFixture(), destinationId: "openpond_managed",
    baseModelId: saved.baseModel.id, maxSteps: 2, optimizerIterations: 3, resizeRolloutBudget: true,
    rolloutGroupSize: 4, rolloutConcurrency: 1, trainingExamples: 2, sequenceLength: saved.dataset.maxPromptTokens,
    rolloutMaxOutputTokens: saved.rollout.maxOutputTokens, rank: saved.lora.rank, learningRate: saved.optimizer.learningRate, klBeta: saved.loss.klBeta });
  if (recipe.method !== "grpo") throw new Error("Expected GRPO");
  expect(recipe.resourceLimits).toEqual({ ...saved.resourceLimits, maxRollouts: 8 });
  expect(recipe.optimizer.iterations).toBe(3);
  expect(recipe.dataset.maxPromptTokens).toBe(saved.dataset.maxPromptTokens);
  expect(recipe.rollout.maxOutputTokens).toBe(saved.rollout.maxOutputTokens);
});
