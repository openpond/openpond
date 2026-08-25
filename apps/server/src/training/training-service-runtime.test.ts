import { describe, expect, test } from "vitest";

import { managedRewardModelRuntime } from "./training-service.js";

describe("managed Reward Model runtime projection", () => {
  test("preserves the qualified processor identity separately from model config", () => {
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
});
