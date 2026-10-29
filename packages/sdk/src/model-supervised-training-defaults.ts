import type { ModelProjectTrainingSetup } from "./model-projects.js";

type Recipe = NonNullable<ModelProjectTrainingSetup["recipe"]>;
const fields = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

/** An editable draft, without invented model or dataset bindings. Execution
 * still requires ManagedSftRecipeSchema and authoritative supervised admission. */
export function createSupervisedTrainingRecipeDefaults(saved?: ModelProjectTrainingSetup["recipe"]): Recipe {
  const source = saved?.method === "sft" ? saved : undefined;
  return {
    schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora",
    ...(source?.baseModel ? { baseModel: source.baseModel } : {}),
    dataset: {
      completionOnly: true, maxSequenceLength: 8_192,
      selectionStrategy: "stable_hash_top_n", selectionSeed: 17,
      ...fields(source?.dataset),
    },
    lora: {
      rank: 16, alpha: 32, dropout: 0,
      targetModules: ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
      ...fields(source?.lora),
    },
    optimizer: {
      learningRate: 0.0001, epochs: 3, maxSteps: 30,
      batchSize: 1, gradientAccumulationSteps: 1, seed: 17,
      ...fields(source?.optimizer),
    },
    resourceLimits: {
      cpuThreads: 4, memoryBytes: 48 * 1024 ** 3, wallTimeMs: 60 * 60 * 1_000,
      ...fields(source?.resourceLimits),
    },
  };
}
