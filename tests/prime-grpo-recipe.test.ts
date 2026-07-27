import { describe, expect, test } from "vitest";

import {
  RftRecipeSchema,
  TasksetSchema,
} from "../packages/contracts/src/index.ts";
import {
  trainingRecipe,
} from "../apps/web/src/components/training/training-start-recipe.ts";
import {
  withAuthoritativeRecipeHashes,
} from "../apps/server/src/training/training-service-helpers.ts";
import {
  MARKETING_PORTFOLIO_HARNESS_CONTRACT_HASH,
} from "../apps/server/src/training/marketing-portfolio-constraint-repair.ts";
import { tasksetFixture } from "./helpers/training-fixtures.ts";

describe("Prime connected-worker GRPO recipe", () => {
  test("builds the bounded two-action recipe and binds the v3 harness hash", () => {
    const base = tasksetFixture({ ready: true });
    const taskset = TasksetSchema.parse({
      ...base,
      environment: {
        ...base.environment,
        metadata: {
          ...base.environment.metadata,
          benchmark: { id: "marketing-portfolio-v1" },
          toolContractHash: "stale-client-tool-contract",
        },
      },
    });
    const clientRecipe = trainingRecipe({
      method: "grpo",
      taskset,
      destinationId: "prime_hosted",
      baseModelId: "Qwen/Qwen3-0.6B",
      maxSteps: 1,
      sequenceLength: 4_096,
      rank: 8,
      learningRate: 0.00005,
      model: null,
      rolloutGroupSize: 4,
      rolloutConcurrency: 4,
      rolloutMaxOutputTokens: 2_048,
      trainingExamples: 1,
      executionMode: "connected_worker",
      catalogModel: {
        selectionKey: "qwen3-0-6b",
        label: "Qwen3 0.6B",
        source: "managed",
        modelId: "Qwen/Qwen3-0.6B",
        revision: "c1899de289a04d12100db370d81485cdf75e47ca",
        tokenizerRevision:
          "c1899de289a04d12100db370d81485cdf75e47ca",
        chatTemplateHash:
          "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
        modelAssetId: null,
        expectedBytes: null,
        cached: false,
        known: true,
        searchResolved: false,
        computeAdapterIds: ["prime-raw"],
        engineAdapterIds: ["connected-prime-rl"],
        preparationState: "ready",
        reason: null,
        compatibilities: [],
      } as any,
    });

    expect(clientRecipe.method).toBe("grpo");
    if (clientRecipe.method !== "grpo") return;
    expect(clientRecipe.rollout).toMatchObject({
      groupSize: 4,
      concurrency: 4,
      maxTurns: 8,
      maxOutputTokens: 2_048,
    });
    expect(clientRecipe.dataset).toMatchObject({
      maxPromptTokens: 4_096,
      maxExamples: 1,
      selectionStrategy: "stable_hash_top_n",
    });
    expect(clientRecipe.optimizer.maxSteps).toBe(1);
    expect(clientRecipe.resourceLimits).toMatchObject({
      wallTimeMs: 20 * 60_000,
      maxRollouts: 4,
    });

    const authoritative = RftRecipeSchema.parse(
      withAuthoritativeRecipeHashes(taskset, clientRecipe),
    );
    expect(authoritative.reward.toolContractHash).toBe(
      MARKETING_PORTFOLIO_HARNESS_CONTRACT_HASH,
    );
    expect(authoritative.policyOptimization?.environment.toolContractHash).toBe(
      MARKETING_PORTFOLIO_HARNESS_CONTRACT_HASH,
    );
    expect(authoritative.policyOptimization?.sampler.maxTurns).toBe(8);
    expect(authoritative.policyOptimization?.budgets).toMatchObject({
      maxRollouts: 4,
      maxEnvironmentExecutions: 4,
      maxOptimizerSteps: 1,
      maxInputTokens: 16_384,
      maxOutputTokens: 8_192,
    });
  });
});
