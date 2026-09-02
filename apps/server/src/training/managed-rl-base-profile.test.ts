import { ModelProjectSchema, type ModelProject } from "@openpond/contracts";
import { describe, expect, it } from "vitest";

import {
  MANAGED_RL_BASE_PROFILE,
  versionModelProjectOntoManagedRlBase,
} from "./managed-rl-base-profile.js";

const hash = (value: string) => value.repeat(64).slice(0, 64);

describe("versionModelProjectOntoManagedRlBase", () => {
  it("changes only the Policy base while preserving Duck-specific setup", () => {
    const oldBase = {
      schemaVersion: "openpond.baseModelPreference.v1" as const,
      modelId: "Qwen/Qwen3-0.6B",
      revision: "c1899de289a04d12100db370d81485cdf75e47ca",
      tokenizerRevision: "c1899de289a04d12100db370d81485cdf75e47ca",
      chatTemplateHash: hash("1"),
      modelAssetId: null,
      source: "managed" as const,
    };
    const project: ModelProject = {
      schemaVersion: "openpond.modelProject.v2",
      id: "duck-model-project",
      profileId: "duck-profile",
      revision: 7,
      name: "Duck NFT structured selection",
      objective: "Improve Duck selection quality",
      defaultBaseModel: oldBase,
      defaultDestinationId: "sandbox-managed-rl",
      trainingSetup: {
        tasksetRef: { id: "duck-taskset", revision: 4, contentHash: hash("2") },
        tasksetRelease: { id: "duck-release", contentHash: hash("3") },
        harnessRelease: { id: "duck-harness", contentHash: hash("4") },
        baseModel: oldBase,
        method: "grpo",
        destinationId: "sandbox-managed-rl",
        managedRolloutPlacement: "remote",
        managedGpuPlacementObjective: "balanced",
        managedGpuRequirement: "any",
        runPreset: "custom",
        recipe: {
          schemaVersion: "openpond.grpoRecipe.v3",
          method: "grpo",
          parameterization: "lora",
          rewardSourceHash: hash("5"),
          trainingProtocolHash: hash("6"),
          evaluationPlanHash: hash("7"),
        },
        preferredMaximumSpendUsd: 9.5,
        preferredRetentionDays: 14,
      },
      hosted: null,
      tasksetSyncs: [],
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    };
    const migrated = versionModelProjectOntoManagedRlBase(
      project,
      "2026-08-31T00:00:00.000Z",
    );
    expect(migrated.revision).toBe(8);
    expect(migrated.trainingSetup.baseModel).toMatchObject({
      modelId: MANAGED_RL_BASE_PROFILE.modelId,
      revision: MANAGED_RL_BASE_PROFILE.revision,
      tokenizerRevision: MANAGED_RL_BASE_PROFILE.tokenizerRevision,
      chatTemplateHash: MANAGED_RL_BASE_PROFILE.chatTemplateHash,
    });
    expect(migrated.trainingSetup.tasksetRef).toEqual(project.trainingSetup.tasksetRef);
    expect(migrated.trainingSetup.tasksetRelease).toEqual(project.trainingSetup.tasksetRelease);
    expect(migrated.trainingSetup.harnessRelease).toEqual(project.trainingSetup.harnessRelease);
    expect(migrated.trainingSetup.recipe).toEqual(project.trainingSetup.recipe);
    expect(migrated.trainingSetup.preferredMaximumSpendUsd).toBe(9.5);
  });

  it("versions the concrete GRPO recipe Policy base with the project base", () => {
    const oldBase = {
      schemaVersion: "openpond.baseModelPreference.v1" as const,
      modelId: "Qwen/Qwen3-0.6B",
      revision: "c1899de289a04d12100db370d81485cdf75e47ca",
      tokenizerRevision: "c1899de289a04d12100db370d81485cdf75e47ca",
      chatTemplateHash: hash("1"),
      modelAssetId: null,
      source: "managed" as const,
    };
    const recipe = {
      schemaVersion: "openpond.rftRecipe.v1" as const,
      method: "grpo" as const,
      parameterization: "lora" as const,
      baseModel: {
        id: oldBase.modelId,
        revision: oldBase.revision,
        tokenizerRevision: oldBase.tokenizerRevision,
        chatTemplateHash: oldBase.chatTemplateHash,
      },
      dataset: {
        trainSplit: "train" as const,
        validationSplit: "frozen_eval" as const,
        maxPromptTokens: 4_096,
        maxExamples: 16,
        selectionStrategy: "stable_hash_top_n" as const,
      },
      lora: { rank: 16 },
      rollout: {
        groupSize: 4,
        concurrency: 4,
        maxTurns: 1,
        maxOutputTokens: 512,
        temperature: 0.8,
        topP: 0.95,
        seed: 17,
      },
      optimizer: { learningRate: 1e-5, maxSteps: 16 },
      loss: { method: "grpo" as const, klBeta: null },
      reward: {
        graderId: "duck-grader",
        graderHash: hash("5"),
        environmentId: "duck-environment",
        environmentVersion: "v1",
        toolContractHash: hash("6"),
      },
      resourceLimits: {
        wallTimeMs: 7_800_000,
        maxRollouts: 64,
        maxPayloadBytes: 1_000_000,
      },
    };
    const project = ModelProjectSchema.parse({
      schemaVersion: "openpond.modelProject.v2",
      id: "duck-rft-project",
      profileId: "duck-profile",
      revision: 5,
      name: "Duck NFT quality",
      objective: "Improve Duck selection quality",
      defaultBaseModel: oldBase,
      defaultDestinationId: "openpond_managed",
      trainingSetup: {
        tasksetRef: { id: "duck-taskset", revision: 8, contentHash: hash("2") },
        tasksetRelease: { id: "duck-release", contentHash: hash("3") },
        harnessRelease: { id: "duck-harness", contentHash: hash("4") },
        baseModel: oldBase,
        method: "grpo",
        destinationId: "openpond_managed",
        managedRolloutPlacement: "remote",
        managedGpuPlacementObjective: "balanced",
        managedGpuRequirement: "any",
        runPreset: "custom",
        recipe,
        preferredMaximumSpendUsd: 9.99,
        preferredRetentionDays: null,
      },
      hosted: null,
      tasksetSyncs: [],
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    });

    const migrated = versionModelProjectOntoManagedRlBase(
      project,
      "2026-08-31T00:00:00.000Z",
    );

    expect(migrated.trainingSetup.recipe).toMatchObject({
      schemaVersion: "openpond.rftRecipe.v1",
      baseModel: {
        id: MANAGED_RL_BASE_PROFILE.modelId,
        revision: MANAGED_RL_BASE_PROFILE.revision,
        tokenizerRevision: MANAGED_RL_BASE_PROFILE.tokenizerRevision,
        chatTemplateHash: MANAGED_RL_BASE_PROFILE.chatTemplateHash,
      },
    });
    expect(migrated.trainingSetup.recipe).toMatchObject({
      dataset: recipe.dataset,
      lora: recipe.lora,
      rollout: recipe.rollout,
      optimizer: recipe.optimizer,
      loss: recipe.loss,
      reward: recipe.reward,
      resourceLimits: recipe.resourceLimits,
    });
  });
});
