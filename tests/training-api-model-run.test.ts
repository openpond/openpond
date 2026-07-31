import { describe, expect, test, vi } from "vitest";

import { createTrainingApi } from "../apps/server/src/training/training-api";

describe("training API Model Run approval forwarding", () => {
  test("forwards explicit export approval to Model Run start", async () => {
    const startModelRun = vi.fn(async (input: unknown) => input);
    const api = createTrainingApi({
      training: { startModelRun },
    } as never);

    await api.request("start_model_run", {
      modelRunId: "run_approved",
      maximumSpendUsd: 2,
      retentionDays: 1,
      exportApproved: true,
    });

    expect(startModelRun).toHaveBeenCalledWith({
      modelRunId: "run_approved",
      maximumSpendUsd: 2,
      retentionDays: 1,
      exportApproved: true,
      manifest: undefined,
    });
  });

  test("does not infer export approval when the caller omits it", async () => {
    const startModelRun = vi.fn(async (input: unknown) => input);
    const api = createTrainingApi({
      training: { startModelRun },
    } as never);

    await api.request("start_model_run", {
      modelRunId: "run_unapproved",
      maximumSpendUsd: 2,
      retentionDays: 1,
    });

    expect(startModelRun).toHaveBeenCalledWith(
      expect.objectContaining({ exportApproved: false }),
    );
  });
});
