import { describe, expect, test } from "vitest";

import {
  rolloutTopologyIncompatibility,
  trainingRecipe,
} from "../apps/web/src/components/training/training-start-recipe";
import { rftTasksetFixture } from "./helpers/managed-training-fixtures";

describe("training start recipe", () => {
  test("projects the selected admitted rollout topology onto the qualified 0.6B recipe", () => {
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
      rolloutConcurrency: 8,
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
        groupSize: 8,
        concurrency: 8,
        maxOutputTokens: 512,
      },
      optimizer: {
        learningRate: 0.00001,
        maxSteps: 1,
      },
      resourceLimits: {
        wallTimeMs: 1_800_000,
        maxRollouts: 8,
      },
    });
  });

  test("admits enough wall time for a full sixteen-step managed run", () => {
    const taskset = rftTasksetFixture();
    const recipe = trainingRecipe({
      method: "grpo",
      taskset,
      destinationId: "openpond_managed",
      baseModelId: "Qwen/Qwen3-0.6B",
      maxSteps: 16,
      sequenceLength: 4_096,
      rank: 16,
      learningRate: 0.00001,
      klBeta: null,
      rolloutGroupSize: 8,
      rolloutConcurrency: 8,
      rolloutMaxOutputTokens: 512,
      trainingExamples: 12,
    });

    expect(recipe.resourceLimits).toMatchObject({
      wallTimeMs: 7_800_000,
      maxRollouts: 128,
    });
  });

  test("rejects rollout topologies that cannot execute in even waves", () => {
    expect(rolloutTopologyIncompatibility({ groupSize: 8, concurrency: 8 })).toBeNull();
    expect(rolloutTopologyIncompatibility({ groupSize: 8, concurrency: 4 })).toBeNull();
    expect(rolloutTopologyIncompatibility({ groupSize: 8, concurrency: 3 })).toContain(
      "divide the rollout group evenly",
    );
    expect(rolloutTopologyIncompatibility({ groupSize: 4, concurrency: 8 })).toContain(
      "without exceeding it",
    );
  });
});
