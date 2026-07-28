import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(240);
const HashSchema = z.string().trim().min(8).max(256);

export const RftLossMethodSchema = z.enum(["grpo", "dapo", "gspo-token"]);

export const TrainingModelRefSchema = z.object({
  id: IdSchema,
  revision: z.string().trim().min(1).max(256),
  tokenizerRevision: z.string().trim().min(1).max(256),
  chatTemplateHash: HashSchema,
});

export const PolicyOptimizationBudgetSchema = z.object({
  maxRollouts: z.number().int().positive().max(1_000_000),
  maxEnvironmentExecutions: z.number().int().positive().max(1_000_000),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxOptimizerSteps: z.number().int().positive().max(1_000_000),
  wallTimeMs: z.number().int().positive(),
  maximumCostUsd: z.number().nonnegative().nullable(),
});

export const GrpoOptimizerSchema = z.object({
  method: z.literal("grpo"),
  groupSize: z.number().int().min(2).max(128),
  normalization: z.literal("group_standardized"),
  loss: RftLossMethodSchema,
});

export const PpoOptimizerSchema = z.object({
  method: z.literal("ppo"),
  valueModel: TrainingModelRefSchema,
  gamma: z.number().min(0).max(1),
  gaeLambda: z.number().min(0).max(1),
  policyClip: z.number().positive().max(1),
  valueClip: z.number().positive().max(10),
  valueLossCoefficient: z.number().nonnegative().max(10),
  ppoEpochs: z.number().int().positive().max(100),
  minibatchSize: z.number().int().positive().max(100_000),
});

export const PolicyOptimizerSchema = z.discriminatedUnion("method", [
  GrpoOptimizerSchema,
  PpoOptimizerSchema,
]);

export const PolicyOptimizationContractSchema = z.object({
  schemaVersion: z.literal("openpond.policyOptimization.v1"),
  policyModel: TrainingModelRefSchema,
  referenceModel: TrainingModelRefSchema,
  dataset: z.object({
    tasksetId: IdSchema,
    tasksetHash: HashSchema,
    split: z.literal("train"),
    selectionStrategy: z.enum(["stable_hash_top_n", "rft_easy_curriculum_v1"]),
    selectionSeed: z.number().int(),
    maxExamples: z.number().int().positive().max(100_000),
  }),
  sampler: z.object({
    temperature: z.number().min(0).max(2),
    topP: z.number().min(0).max(1),
    maxOutputTokens: z.number().int().positive().max(32_768),
    maxTurns: z.number().int().positive().max(1_000),
    concurrency: z.number().int().positive().max(1_000),
  }),
  environment: z.object({
    id: IdSchema,
    version: z.string().trim().min(1).max(256),
    toolContractHash: HashSchema,
  }),
  reward: z.object({
    graderId: IdSchema,
    graderHash: HashSchema,
  }),
  kl: z.object({
    coefficient: z.number().nonnegative().nullable(),
    referenceConstraint: z.literal("fixed_reference"),
  }),
  budgets: PolicyOptimizationBudgetSchema,
  checkpointEverySteps: z.number().int().positive(),
  seed: z.number().int(),
  evaluationSplit: z.literal("frozen_eval"),
  optimizer: PolicyOptimizerSchema,
});
