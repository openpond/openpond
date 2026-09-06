import { expect, test } from "vitest";
import { TrainingRecipeSchema } from "@openpond/contracts";
import { managedRftRecipe, rftTasksetFixture } from "./helpers/managed-training-fixtures.js";
import { withAuthoritativeRecipeHashes } from "../apps/server/src/training/training-service-helpers.js";

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
