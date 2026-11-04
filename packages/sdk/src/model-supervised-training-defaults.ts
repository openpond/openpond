import type { ModelProjectTrainingSetup } from "./model-projects.js";

type Recipe = NonNullable<ModelProjectTrainingSetup["recipe"]>;
const fields = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

// Exact-source authoring settings only. Availability is determined by the
// connected service when preparing a run, never by these editable defaults.
const denseSources = [
  { id: "Qwen/Qwen3.5-4B", revision: "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a",
    chatTemplateHash: "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715", rank: 16, memoryBytes: 24_000_000_000 },
  { id: "Qwen/Qwen3.5-9B", revision: "c202236235762e1c871ad0ccb60c8ee5ba337b9a",
    chatTemplateHash: "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715", rank: 16, memoryBytes: 48_000_000_000 },
  { id: "Qwen/Qwen3.8-27B", revision: "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0",
    chatTemplateHash: "c3cf9e34abf4f9e36c2d72165aa9c132d3e2a725b6c2586aaa3a8af9d7a81041", rank: 8, memoryBytes: 80_000_000_000 },
] as const;

/** An editable draft, without invented model or dataset bindings. Execution
 * still requires ManagedSftRecipeSchema and authoritative supervised admission. */
export function createSupervisedTrainingRecipeDefaults(
  saved?: ModelProjectTrainingSetup["recipe"],
  baseModel?: ModelProjectTrainingSetup["baseModel"],
): Recipe {
  const source = saved?.method === "sft" ? saved : undefined;
  const base = baseModel ? { id: baseModel.modelId, revision: baseModel.revision,
    tokenizerRevision: baseModel.tokenizerRevision, chatTemplateHash: baseModel.chatTemplateHash } : fields(source?.baseModel);
  const dense = denseSources.find(candidate => candidate.id === base.id && candidate.revision === base.revision
    && candidate.revision === base.tokenizerRevision && candidate.chatTemplateHash === base.chatTemplateHash);
  const rank = dense?.rank ?? 16;
  return {
    schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora",
    ...(source?.baseModel ? { baseModel: source.baseModel } : {}),
    dataset: {
      completionOnly: true, maxSequenceLength: 8_192,
      selectionStrategy: "stable_hash_top_n", selectionSeed: 17,
      ...fields(source?.dataset),
    },
    lora: {
      rank, alpha: rank * 2, dropout: 0,
      targetModules: dense ? ["down_proj", "gate_proj", "up_proj"]
        : ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
      ...fields(source?.lora),
    },
    optimizer: {
      learningRate: 0.0001, epochs: 3, maxSteps: 30,
      batchSize: 1, gradientAccumulationSteps: 1, seed: 17,
      ...fields(source?.optimizer),
    },
    resourceLimits: {
      cpuThreads: 4, memoryBytes: dense?.memoryBytes ?? 48 * 1024 ** 3, wallTimeMs: 60 * 60 * 1_000,
      ...fields(source?.resourceLimits),
    },
  };
}
