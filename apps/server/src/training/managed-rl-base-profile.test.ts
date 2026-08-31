import type { ModelProject } from "@openpond/contracts";
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
});
