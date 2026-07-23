import { describe, expect, test } from "vitest";
import {
  PpoRecipeSchema,
  RftRecipeSchema,
  TrainingPlanSchema,
  TrainingRecipeSchema,
  type PolicyOptimizationContract,
} from "../packages/contracts/src";
import { comparePolicyOptimizationPlans } from "../packages/training-sdk/src";

const timestamp = "2026-07-23T12:00:00.000Z";
const hash = "a".repeat(64);
const model = {
  id: "openpond/tiny-cpu-gpt2-fixture",
  revision: "architecture-v2-seed-17-context-512",
  tokenizerRevision: "wordlevel-v1",
  chatTemplateHash: "fixture00000000",
};

describe("policy optimization contracts", () => {
  test("PPO is an executable recipe with explicit critic and resume lineage", () => {
    const recipe = ppoRecipe();
    expect(TrainingRecipeSchema.parse(recipe).method).toBe("ppo");
    expect(recipe.policyOptimization.optimizer.valueModel.id).toContain("value-head");
    expect(recipe.resume).toMatchObject({
      policyHash: "policyhash",
      referenceHash: "referencehash",
      valueModelHash: "valuemodelhash",
      optimizerStateHash: null,
    });
  });

  test("GRPO and PPO compare only when Dataset, models, reward, environment, and rollout budgets match", () => {
    const common = policyOptimization();
    const grpo = plan("plan_grpo", RftRecipeSchema.parse({
      schemaVersion: "openpond.rftRecipe.v1",
      method: "grpo",
      parameterization: "lora",
      baseModel: model,
      dataset: {
        trainSplit: "train",
        validationSplit: "frozen_eval",
        maxPromptTokens: 64,
        maxExamples: 2,
        selectionStrategy: "stable_hash_top_n",
      },
      lora: { rank: 2 },
      rollout: {
        groupSize: 2,
        concurrency: 1,
        maxTurns: 1,
        maxOutputTokens: 4,
        temperature: 0.8,
        topP: 0.95,
        seed: 17,
      },
      optimizer: { learningRate: 0.01, maxSteps: 2 },
      loss: { method: "grpo", klBeta: 0.05 },
      reward: {
        graderId: "exact",
        graderHash: hash,
        environmentId: "fixture",
        environmentVersion: "v1",
        toolContractHash: "no-tools-v1",
      },
      resourceLimits: {
        wallTimeMs: 120_000,
        maxRollouts: 2,
        maxPayloadBytes: 1_000_000,
      },
      policyOptimization: {
        ...common,
        optimizer: {
          method: "grpo",
          groupSize: 2,
          normalization: "group_standardized",
          loss: "grpo",
        },
      },
    }));
    const ppo = plan("plan_ppo", ppoRecipe());

    const comparison = comparePolicyOptimizationPlans(grpo, ppo);
    expect(comparison.comparable).toBe(true);
    expect(comparison.shared).toMatchObject({
      tasksetId: "dataset_fixture",
      tasksetHash: hash,
      evaluationSplit: "frozen_eval",
    });

    const changed = plan("plan_ppo_changed", PpoRecipeSchema.parse({
      ...ppoRecipe(),
      policyOptimization: {
        ...ppoRecipe().policyOptimization,
        budgets: {
          ...ppoRecipe().policyOptimization.budgets,
          maxOutputTokens: 9,
        },
      },
    }));
    expect(comparePolicyOptimizationPlans(grpo, changed)).toMatchObject({
      comparable: false,
      mismatches: ["rollout_budget"],
      shared: null,
    });
  });
});

function policyOptimization(): PolicyOptimizationContract {
  return {
    schemaVersion: "openpond.policyOptimization.v1",
    policyModel: model,
    referenceModel: model,
    dataset: {
      tasksetId: "dataset_fixture",
      tasksetHash: hash,
      split: "train",
      selectionStrategy: "stable_hash_top_n",
      selectionSeed: 17,
      maxExamples: 2,
    },
    sampler: {
      temperature: 0.8,
      topP: 0.95,
      maxOutputTokens: 4,
      maxTurns: 1,
      concurrency: 1,
    },
    environment: {
      id: "fixture",
      version: "v1",
      toolContractHash: "no-tools-v1",
    },
    reward: { graderId: "exact", graderHash: hash },
    kl: { coefficient: 0.05, referenceConstraint: "fixed_reference" },
    budgets: {
      maxRollouts: 2,
      maxEnvironmentExecutions: 2,
      maxInputTokens: 128,
      maxOutputTokens: 8,
      maxOptimizerSteps: 2,
      wallTimeMs: 120_000,
      maximumCostUsd: 0,
    },
    checkpointEverySteps: 1,
    seed: 17,
    evaluationSplit: "frozen_eval",
    optimizer: {
      method: "ppo",
      valueModel: { ...model, id: `${model.id}:value-head-v1` },
      gamma: 1,
      gaeLambda: 0.95,
      policyClip: 0.2,
      valueClip: 0.2,
      valueLossCoefficient: 0.5,
      ppoEpochs: 2,
      minibatchSize: 1,
    },
  };
}

function ppoRecipe() {
  return PpoRecipeSchema.parse({
    schemaVersion: "openpond.ppoRecipe.v1",
    method: "ppo",
    parameterization: "lora",
    policyOptimization: policyOptimization(),
    lora: {
      rank: 2,
      alpha: 4,
      dropout: 0,
      targetModules: ["c_attn"],
    },
    valueHead: {
      initialization: "policy_hidden_state_linear",
      optimizerLearningRate: 0.01,
      artifactName: "value_head.safetensors",
    },
    policyLearningRate: 0.01,
    resume: {
      checkpointId: null,
      policyHash: "policyhash",
      referenceHash: "referencehash",
      valueModelHash: "valuemodelhash",
      optimizerStateHash: null,
    },
    resourceLimits: {
      cpuThreads: 2,
      memoryBytes: 2_000_000_000,
      wallTimeMs: 120_000,
    },
  });
}

function plan(
  id: string,
  recipe: ReturnType<typeof ppoRecipe> | ReturnType<typeof RftRecipeSchema.parse>,
) {
  return TrainingPlanSchema.parse({
    schemaVersion: "openpond.trainingPlan.v1",
    id,
    modelId: "model_fixture",
    tasksetId: "dataset_fixture",
    tasksetHash: hash,
    destinationId: recipe.method === "ppo" ? "local_cpu_fixture" : "fireworks",
    recipe,
    environmentPlacement: recipe.method === "ppo" ? "local" : "provider_native",
    compatibility: {
      schemaVersion: "openpond.trainingCompatibility.v1",
      compatible: true,
      destinationId: recipe.method === "ppo" ? "local_cpu_fixture" : "fireworks",
      tasksetId: "dataset_fixture",
      recipeMethod: recipe.method,
      issues: [],
      checkedAt: timestamp,
    },
    dataPolicy: {
      exportApproved: true,
      approvedSourceIds: ["source_fixture"],
      retentionDays: null,
      region: null,
    },
    rftSignalGate: null,
    estimatedCostUsd: 0,
    createdAt: timestamp,
    contentHash: hash,
  });
}
