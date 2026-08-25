import { describe, expect, test, vi } from "vitest";

import { createTrainingApi } from "../apps/server/src/training/training-api";

describe("training API Model Run approval forwarding", () => {
  test("forwards Reward Model cancellation to its separate lifecycle", async () => {
    const cancelRewardModelRun = vi.fn(async (runId: string) => ({ runId }));
    const api = createTrainingApi({ training: { cancelRewardModelRun } } as never);

    await api.request("reward_model_run_cancel", { runId: "reward-run-rm0" });

    expect(cancelRewardModelRun).toHaveBeenCalledWith("reward-run-rm0");
  });

  test("forwards explicit export approval to Model Run start", async () => {
    const startModelRun = vi.fn(async (input: unknown) => input);
    const api = createTrainingApi({
      store: {
        getModelRunDraft: vi.fn(async () => ({ destinationId: "local", status: "ready_to_run" })),
      },
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
      store: {
        getModelRunDraft: vi.fn(async () => ({ destinationId: "local", status: "ready_to_run" })),
      },
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

  test("publishes the exact Taskset release before a managed Model Run starts", async () => {
    const release = {
      schemaVersion: "openpond.tasksetRelease.v1",
      id: "taskset-release-1",
      revision: 3,
      contentHash: "a".repeat(64),
    };
    const taskset = { id: "taskset_1" };
    const publishTaskset = vi.fn(async () => ({ id: "model_1" }));
    const startModelRun = vi.fn(async (input: unknown) => input);
    const api = createTrainingApi({
      benchmarkTasksets: {
        releaseForTaskset: vi.fn(async () => release),
      },
      modelProjectHosting: { publishTaskset },
      store: {
        getModelRunDraft: vi.fn(async () => ({
          destinationId: "openpond_managed",
          modelId: "model_1",
          status: "ready_to_run",
          tasksetRef: { id: "taskset_1" },
        })),
        getTaskset: vi.fn(async () => taskset),
      },
      training: { startModelRun },
    } as never);

    await api.request("start_model_run", { modelRunId: "run_managed" });

    expect(publishTaskset).toHaveBeenCalledWith({
      projectId: "model_1",
      taskset,
      release,
    });
    expect(startModelRun).toHaveBeenCalledOnce();
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

  test("pins the preference dataset's released Taskset envelope in Reward Model recipes", async () => {
    const tasksetRelease = {
      id: "taskset-release-t0-r1",
      revision: 1,
      contentHash: "b".repeat(64),
    };
    const comparisonRelease = {
      id: "comparison-r1",
      contentHash: "d".repeat(64),
    };
    const launchRewardModel = vi.fn(async (input: unknown) => input);
    const api = createTrainingApi({
      store: {
        getTaskset: vi.fn(async () => ({
          id: "taskset-t0",
          contentHash: "a".repeat(64),
        })),
        getPreferenceComparisonRelease: vi.fn(async () => ({
          tasksetId: "taskset-t0",
          tasksetRelease,
          release: comparisonRelease,
        })),
      },
      preferenceComparisons: {
        listPreferenceDatasets: vi.fn(async () => [{
          id: "preferences-d0",
          contentHash: "c".repeat(64),
          tasksetRelease,
          comparisonRelease,
        }]),
      },
      training: { launchRewardModel },
    } as never);

    await api.request("reward_model_run_launch", {
      id: "reward-run-rm0",
      tasksetId: "taskset-t0",
      rewardModelId: "reward-model-r0",
      preferenceDatasetReleaseId: "preferences-d0",
    });

    expect(launchRewardModel).toHaveBeenCalledWith(expect.objectContaining({
      tasksetRelease,
      recipe: expect.objectContaining({
        tasksetRelease: {
          id: tasksetRelease.id,
          contentHash: tasksetRelease.contentHash,
        },
      }),
    }));
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
