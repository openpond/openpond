import { describe, expect, test } from "vitest";

import {
  managedRewardModelRuntime,
  nextRewardModelVersionNumber,
} from "./training-service.js";

describe("managed Reward Model runtime projection", () => {
  test("preserves the verified processor identity separately from model config", () => {
    const runtime = managedRewardModelRuntime(
      {
        source: "huggingface",
        repoId: "Qwen/Qwen3-0.6B",
        revision: "c1899de289a04d12100db370d81485cdf75e47ca",
        configHash: "a".repeat(64),
        tokenizerHash: "b".repeat(64),
        licenseId: "apache-2.0",
        gated: false,
      },
      {
        repository: "Qwen/Qwen3-0.6B",
        revision: "c1899de289a04d12100db370d81485cdf75e47ca",
        configHash: "c".repeat(64),
      },
    );

    expect(runtime.baseModel.configHash).toBe("a".repeat(64));
    expect(runtime.processor.configHash).toBe("c".repeat(64));
  });

  test("rejects a processor from a different immutable release", () => {
    expect(() =>
      managedRewardModelRuntime(
        {
          source: "huggingface",
          repoId: "Qwen/Qwen3-0.6B",
          revision: "c1899de289a04d12100db370d81485cdf75e47ca",
          configHash: "a".repeat(64),
          tokenizerHash: "b".repeat(64),
          licenseId: "apache-2.0",
          gated: false,
        },
        {
          repository: "Qwen/Qwen3-0.6B",
          revision: "d".repeat(40),
          configHash: "c".repeat(64),
        },
      ),
    ).toThrow("processor must match its immutable base release");
  });

  test("allocates the next immutable version within one reward-model lineage", () => {
    const versions = [
      { modelId: "reward-a", version: 1 },
      { modelId: "reward-b", version: 7 },
      { modelId: "reward-a", version: 3 },
    ] as Parameters<typeof nextRewardModelVersionNumber>[0];

    expect(nextRewardModelVersionNumber(versions, "reward-a")).toBe(4);
    expect(nextRewardModelVersionNumber(versions, "reward-new")).toBe(1);
  });
});
