import { describe, expect, test } from "vitest";

import { bindLearnedPreferenceReward } from "./learned-preference-reward-binding.js";

const hash = (character: string) => character.repeat(64);

function availableVersion() {
  return {
    schemaVersion: "openpond.rewardModelVersion.v1",
    id: "reward-model-version-r1",
    modelId: "reward-model",
    profileId: "profile",
    version: 1,
    role: "reward",
    status: "available",
    scope: "synthetic_smoke",
    baseModel: { id: "Qwen/Qwen3-0.6B", revision: "a".repeat(40) },
    runtime: {
      baseModel: {
        source: "huggingface",
        repoId: "Qwen/Qwen3-0.6B",
        revision: "a".repeat(40),
        configHash: hash("a"),
        tokenizerHash: hash("b"),
        licenseId: "apache-2.0",
        gated: false,
      },
      processor: {
        repository: "Qwen/Qwen3-0.6B",
        revision: "a".repeat(40),
        configHash: hash("c"),
      },
    },
    taskset: { id: "source-taskset", revision: 1, contentHash: hash("d") },
    preferenceDatasetRelease: { id: "preferences", contentHash: hash("e") },
    releaseGraph: {
      resolvedBundleHash: hash("f"),
      profileRelease: { id: "profile", revision: 1, contentHash: hash("1") },
      harnessRelease: { id: "harness", contentHash: hash("2") },
      grader: { id: "grader", contentHash: hash("3") },
    },
    artifacts: {
      checkpoint: {
        id: "checkpoint",
        contentHash: hash("4"),
        objectRef: "r2://managed/checkpoint",
        files: ["adapter/config.json", "adapter/model.safetensors", "head.pt", "processor.json"].map(
          (path, index) => ({ path, sizeBytes: index + 1, sha256: hash(String(index + 5)) }),
        ),
      },
      adapter: { id: "adapter", contentHash: hash("9") },
      scalarHead: { id: "head", contentHash: hash("a") },
      bucketHead: null,
      processorRelease: { id: "processor", contentHash: hash("b") },
    },
    qualificationReport: null,
    createdAt: "2026-08-30T12:00:00.000Z",
    contentHash: hash("c"),
  } as const;
}

describe("learned preference reward binding", () => {
  test("binds an immutable scorer without making qualification an execution gate", () => {
    const binding = bindLearnedPreferenceReward({
      version: availableVersion() as never,
      qualificationReport: null,
      rewardComposerRelease: { id: "composer", contentHash: hash("d") },
      executionReceipt: { id: "receipt", contentHash: hash("e") },
    });

    expect(binding.qualificationReport).toBeNull();
    expect(binding.evaluationReferences).toEqual([]);
    expect(binding.rewardModelVersion.id).toBe("reward-model-version-r1");
    expect(binding.checkpoint.objectRef).toBe("r2://managed/checkpoint");
  });
});
