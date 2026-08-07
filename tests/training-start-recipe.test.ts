import { describe, expect, test } from "vitest";

import { trainingRecipe } from "../apps/web/src/components/training/training-start-recipe";
import { rftTasksetFixture } from "./helpers/managed-training-fixtures";

describe("training start recipe", () => {
  test("projects OpenPond Managed GRPO onto the qualified 0.6B recipe", () => {
    const recipe = trainingRecipe({
      method: "grpo",
      taskset: rftTasksetFixture(),
      destinationId: "openpond_managed",
      baseModelId: "Qwen/Qwen3-0.6B",
      maxSteps: 1,
      sequenceLength: 512,
      rank: 2,
      learningRate: 0.0002,
      model: null,
      rolloutGroupSize: 8,
      rolloutConcurrency: 1,
      rolloutMaxOutputTokens: 64,
      trainingExamples: 1,
      executionMode: "provider_native",
      catalogModel: {
        selectionKey: "managed-qwen3-0-6b",
        label: "Qwen3 0.6B",
        source: "managed",
        modelId: "Qwen/Qwen3-0.6B",
        revision: "c1899de289a04d12100db370d81485cdf75e47ca",
        tokenizerRevision: "c1899de289a04d12100db370d81485cdf75e47ca",
        chatTemplateHash:
          "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
        modelAssetId: null,
        expectedBytes: null,
        cached: false,
        known: true,
        searchResolved: true,
        computeAdapterIds: ["openpond-managed"],
        engineAdapterIds: ["sandbox-managed-rl"],
        preparationState: "ready",
        reason: null,
        compatibilities: [],
      },
    });

    expect(recipe).toMatchObject({
      method: "grpo",
      dataset: {
        maxPromptTokens: 4_096,
        maxExamples: 1,
      },
      lora: { rank: 16 },
      rollout: {
        groupSize: 4,
        concurrency: 4,
        maxOutputTokens: 512,
      },
      optimizer: {
        learningRate: 0.00001,
        maxSteps: 1,
      },
      resourceLimits: {
        wallTimeMs: 1_800_000,
        maxRollouts: 4,
      },
    });
  });
});
