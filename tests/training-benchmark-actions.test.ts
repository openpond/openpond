import { describe, expect, test, vi } from "vitest";

import { startHarnessRefinerBenchmark } from "../apps/server/src/training/training-benchmark-actions.js";

const input = {
  modelId: "model-1",
  profileId: "profile-1",
  model: { providerId: "openpond", modelId: "openpond-chat" },
  reasoningEffort: "high",
};

describe("Harness Refiner benchmark API admission", () => {
  test("uses the canonical positive spend ceiling when the client omits one", async () => {
    const start = vi.fn(async (value: unknown) => value);

    await startHarnessRefinerBenchmark({ start } as never, input);

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      seeds: [17],
      repetitions: 1,
      maximumSpendUsd: 10,
    }));
  });

  test("rejects an unlimited zero ceiling before starting the run", () => {
    const start = vi.fn();

    expect(() => startHarnessRefinerBenchmark({ start } as never, {
      ...input,
      maximumSpendUsd: 0,
    })).toThrow("greater than zero");
    expect(start).not.toHaveBeenCalled();
  });
});
