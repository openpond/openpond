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

  test("forwards the exact Taskset and qualified Reward Model Version for a policy binding", async () => {
    const learnedPreferenceRewardBinding = vi.fn(async (input: unknown) => ({
      ...input as Record<string, unknown>,
      rewardComposerRelease: { id: "reward-composer-r0", contentHash: "a".repeat(64) },
    }));
    const api = createTrainingApi({
      training: { learnedPreferenceRewardBinding },
    } as never);

    await expect(api.request("learned_preference_reward_binding", {
      tasksetId: "taskset-t0",
      rewardModelVersionId: "reward-r0",
    })).resolves.toMatchObject({
      tasksetId: "taskset-t0",
      rewardModelVersionId: "reward-r0",
    });
    expect(learnedPreferenceRewardBinding).toHaveBeenCalledWith({
      tasksetId: "taskset-t0",
      rewardModelVersionId: "reward-r0",
    });
  });

  test("routes evaluation cancellation to the Harness Refiner execution", async () => {
    const cancelEvaluation = vi.fn(async (id: string) => ({ id, status: "cancelled" }));
    const cancelTraining = vi.fn();
    const api = createTrainingApi({
      store: {
        getModelRun: vi.fn(async () => ({ kind: "evaluation" })),
      },
      training: { cancelModelRun: cancelTraining },
      harnessRefinerBenchmarks: { cancel: cancelEvaluation },
    } as never);

    await api.request("cancel_model_run", { modelRunId: "model_run_eval" });

    expect(cancelEvaluation).toHaveBeenCalledWith("model_run_eval");
    expect(cancelTraining).not.toHaveBeenCalled();
  });

  test("keeps non-evaluation cancellation on the training execution", async () => {
    const cancelEvaluation = vi.fn();
    const cancelTraining = vi.fn(async (id: string) => ({ id, status: "cancelled" }));
    const api = createTrainingApi({
      store: {
        getModelRun: vi.fn(async () => ({ kind: "training" })),
      },
      training: { cancelModelRun: cancelTraining },
      harnessRefinerBenchmarks: { cancel: cancelEvaluation },
    } as never);

    await api.request("cancel_model_run", { modelRunId: "model_run_training" });

    expect(cancelTraining).toHaveBeenCalledWith("model_run_training");
    expect(cancelEvaluation).not.toHaveBeenCalled();
  });

  test("routes evaluation resume to the durable Harness Refiner checkpoint", async () => {
    const resume = vi.fn(async (id: string) => ({ id, status: "running" }));
    const api = createTrainingApi({
      store: {
        getModelRun: vi.fn(async () => ({ kind: "evaluation" })),
      },
      harnessRefinerBenchmarks: { resume },
    } as never);

    await api.request("resume_model_run", { modelRunId: "model_run_eval" });

    expect(resume).toHaveBeenCalledWith("model_run_eval");
  });
});
