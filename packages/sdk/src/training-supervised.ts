import { z } from "zod";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().trim().min(8).max(256);

/** Shared recipe for the public API, local workbench, and managed executor.
 * Supervised training has no rollout-group, reward, or relative-loss settings.
 */
export const SftRecipeSchema = z.object({
  schemaVersion: z.literal("openpond.sftRecipe.v1"),
  method: z.literal("sft"),
  parameterization: z.literal("lora"),
  baseModel: z.object({
    id: Id,
    revision: z.string().trim().min(1).max(256),
    tokenizerRevision: z.string().trim().min(1).max(256),
    chatTemplateHash: Hash,
  }),
  dataset: z.object({
    trainSplit: z.literal("train"),
    validationSplit: z.enum(["validation", "frozen_eval"]),
    completionOnly: z.boolean(),
    maxSequenceLength: z.number().int().positive().max(32_768),
    maxExamples: z.number().int().positive().max(100_000).default(1_000),
    selectionStrategy: z.literal("stable_hash_top_n").default("stable_hash_top_n"),
    selectionSeed: z.number().int().default(17),
  }),
  lora: z.object({
    rank: z.number().int().positive().max(256),
    alpha: z.number().positive().max(1_024),
    dropout: z.number().min(0).max(1),
    targetModules: z.array(Id).min(1).max(100),
  }),
  optimizer: z.object({
    learningRate: z.number().positive(),
    epochs: z.number().positive().max(100),
    maxSteps: z.number().int().positive().max(1_000_000),
    batchSize: z.number().int().positive().max(10_000),
    gradientAccumulationSteps: z.number().int().positive().max(10_000),
    seed: z.number().int(),
  }),
  resourceLimits: z.object({
    cpuThreads: z.number().int().positive().max(256),
    memoryBytes: z.number().int().positive(),
    wallTimeMs: z.number().int().positive(),
  }),
});
export type SftRecipe = z.infer<typeof SftRecipeSchema>;

/** The first managed SFT worker has a deliberately bounded execution surface.
 * This is an executable requirement, not an advertised fleet capability.
 */
export const ManagedSftRecipeSchema = SftRecipeSchema.safeExtend({
  dataset: SftRecipeSchema.shape.dataset.safeExtend({
    completionOnly: z.literal(true),
    maxSequenceLength: z.number().int().min(2).max(8192),
    maxExamples: z.number().int().min(1).max(1000).default(1000),
  }),
  lora: SftRecipeSchema.shape.lora.safeExtend({
    rank: z.number().int().min(1).max(64),
    dropout: z.number().min(0).lt(1),
    targetModules: z
      .array(z.enum(["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]))
      .min(1)
      .max(7),
  }),
  optimizer: SftRecipeSchema.shape.optimizer.safeExtend({
    learningRate: z.number().positive().max(0.001),
    epochs: z.number().positive().max(10),
    maxSteps: z.number().int().min(1).max(128),
    batchSize: z.number().int().min(1).max(32),
    gradientAccumulationSteps: z.number().int().min(1).max(32),
    seed: z
      .number()
      .int()
      .min(-(2 ** 31))
      .max(2 ** 31 - 1),
  }),
  resourceLimits: SftRecipeSchema.shape.resourceLimits.safeExtend({
    wallTimeMs: z.number().int().min(1000).max(21_600_000),
  }),
}).superRefine((recipe, context) => {
  if (recipe.optimizer.batchSize * recipe.optimizer.gradientAccumulationSteps > 32)
    context.addIssue({
      code: "custom",
      path: ["optimizer"],
      message: "Managed SFT supports at most 32 accumulated examples.",
    });
  if (new Set(recipe.lora.targetModules).size !== recipe.lora.targetModules.length)
    context.addIssue({
      code: "custom",
      path: ["lora", "targetModules"],
      message: "Adapter target modules must be unique.",
    });
});
