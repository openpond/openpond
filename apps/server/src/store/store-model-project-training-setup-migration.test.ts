import { describe, expect, it } from "vitest";

import { sanitizeUnverifiableLearnedPreferenceBindings } from "./store-model-project-training-setup-migration.js";

const hash = (character: string) => character.repeat(64);

function receiptBoundScorer() {
  return {
    rewardModelVersion: { id: "reward-model-version", contentHash: hash("a") },
    qualificationReport: { id: "qualification-report", contentHash: hash("b") },
    evaluationReferences: [],
    checkpoint: {
      id: "checkpoint",
      contentHash: hash("c"),
      objectRef: "r2://bucket/checkpoint",
      files: ["adapter", "head", "processor", "evidence"].map((path, index) => ({
        path,
        sizeBytes: index + 1,
        sha256: hash(String(index + 1)),
      })),
    },
    runtime: {
      baseModel: {
        source: "huggingface",
        repoId: "Qwen/Qwen3-0.6B",
        revision: "d".repeat(40),
        configHash: hash("d"),
        tokenizerHash: hash("e"),
        licenseId: "apache-2.0",
        gated: false,
      },
      processor: {
        repository: "Qwen/Qwen3-0.6B",
        revision: "d".repeat(40),
        configHash: hash("f"),
      },
    },
    processorRelease: { id: "processor", contentHash: hash("a") },
    rewardComposerRelease: { id: "composer", contentHash: hash("b") },
    executionReceipt: { id: "execution-receipt", contentHash: hash("c") },
  };
}

describe("Model Project training setup migration", () => {
  it("unbinds legacy learned scorers that have no V2 execution receipt", () => {
    const legacy = {
      recipe: {
        reward: {
          learnedPreference: {
            rewardModelVersion: { id: "legacy", contentHash: hash("a") },
            qualificationKind: "synthetic_smoke",
          },
        },
        policyOptimization: {
          reward: {
            learnedPreference: {
              rewardModelVersion: { id: "legacy", contentHash: hash("a") },
            },
          },
        },
      },
    };

    const normalized = sanitizeUnverifiableLearnedPreferenceBindings(legacy);

    expect(normalized.changed).toBe(true);
    expect(normalized.value).toMatchObject({
      recipe: {
        reward: { learnedPreference: null },
        policyOptimization: { reward: { learnedPreference: null } },
      },
    });
  });

  it("keeps a receipt-bound scorer while removing the retired qualification label", () => {
    const normalized = sanitizeUnverifiableLearnedPreferenceBindings({
      learnedPreference: {
        ...receiptBoundScorer(),
        qualificationKind: "synthetic_smoke",
      },
    });

    expect(normalized.changed).toBe(true);
    expect(normalized.value).toEqual({ learnedPreference: receiptBoundScorer() });
  });
});
