import { describe, expect, test, vi } from "vitest";
import { ModelRunSchema } from "@openpond/contracts";

import { createHarnessRefinerBenchmarkService } from "../apps/server/src/training/harness-refiner-benchmark-service.js";
import { isCheckpointResumeTransition } from "../apps/server/src/store/store-training-models.js";

const HASH = "a".repeat(64);

function runningEvaluationRun() {
  return ModelRunSchema.parse({
    schemaVersion: "openpond.modelRun.v1",
    id: "model_run_cancel_test",
    modelId: "model_cancel_test",
    modelVersionId: "model_version_cancel_test",
    profileId: "default",
    kind: "evaluation",
    status: "running",
    method: null,
    destinationId: null,
    taskset: { id: "taskset_cancel_test", revision: 1, contentHash: HASH },
    harnessRelease: { id: "harness_cancel_test", contentHash: HASH },
    quote: null,
    evaluation: {
      benchmarkId: "harness-refiner",
      model: { providerId: "openpond", modelId: "openpond-chat" },
      upstreamModel: {
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        revision: "deepseek-2026-07-31",
      },
      reasoningEffort: "high",
      seeds: [17],
      repetitions: 1,
      maximumSpendUsd: 1,
      attemptPlan: [
        { stage: "baseline", split: "frozen_eval", taskIds: ["held-out"], attemptCount: 1 },
        { stage: "adaptation", split: "validation", taskIds: ["adaptation"], attemptCount: 1 },
        { stage: "candidate_adaptation", split: "validation", taskIds: ["adaptation"], attemptCount: 1 },
        { stage: "candidate", split: "frozen_eval", taskIds: ["held-out"], attemptCount: 1 },
      ],
    },
    evaluationProgress: {
      stage: "adaptation",
      completedAttempts: 2,
      totalAttempts: 4,
      accounting: {
        usage: {
          baseline: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.01 },
          adaptation: { inputTokens: 8, outputTokens: 2, totalTokens: 10, costUsd: 0.01 },
          candidateAdaptation: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null },
          candidate: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null },
          refiner: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null },
          grader: { inputTokens: 4, outputTokens: 1, totalTokens: 5, costUsd: 0.001 },
        },
        observedSpendUsd: 0.021,
        attempts: [],
      },
    },
    reward: null,
    receipt: null,
    adapterArtifactLineageId: null,
    failure: null,
    startedAt: "2026-08-10T00:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-08-10T00:00:00.000Z",
  });
}

describe("Harness Refiner benchmark cancellation", () => {
  test("terminalizes an evaluation without discarding its accounting checkpoint", async () => {
    const run = runningEvaluationRun();
    const saveModelRun = vi.fn(async (value: typeof run) => value);
    const service = createHarnessRefinerBenchmarkService({
      store: {
        getModelRun: vi.fn(async () => run),
        saveModelRun,
      },
      now: () => "2026-08-10T00:01:00.000Z",
    } as never);

    const cancelled = await service.cancel(run.id);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.failure).toBe("Benchmark cancelled by operator.");
    expect(cancelled.evaluationProgress?.accounting?.observedSpendUsd).toBe(0.021);
    expect(saveModelRun).toHaveBeenCalledOnce();
  });

  test("permits durable Refiner and comparison checkpoints to re-enter running state", () => {
    const source = runningEvaluationRun();
    const failed = ModelRunSchema.parse({
      ...source,
      status: "failed",
      evaluationProgress: {
        ...source.evaluationProgress!,
        stage: "refiner",
        completedAttempts: 2,
      },
      failure: "Refiner boundary failed.",
      completedAt: "2026-08-10T00:01:00.000Z",
      updatedAt: "2026-08-10T00:01:00.000Z",
    });
    const resumed = ModelRunSchema.parse({
      ...failed,
      status: "running",
      failure: null,
      completedAt: null,
      updatedAt: "2026-08-10T00:02:00.000Z",
    });

    expect(isCheckpointResumeTransition(failed, resumed)).toBe(true);
    expect(isCheckpointResumeTransition(failed, ModelRunSchema.parse({
      ...resumed,
      evaluationProgress: {
        ...resumed.evaluationProgress!,
        completedAttempts: 1,
      },
    }))).toBe(false);

    const failedComparison = ModelRunSchema.parse({
      ...failed,
      evaluationProgress: {
        ...failed.evaluationProgress!,
        stage: "comparison",
        completedAttempts: 4,
      },
      receipt: null,
    });
    const resumedComparison = ModelRunSchema.parse({
      ...failedComparison,
      status: "running",
      failure: null,
      completedAt: null,
      updatedAt: "2026-08-10T00:02:00.000Z",
    });
    expect(isCheckpointResumeTransition(failedComparison, resumedComparison)).toBe(true);

    const cancelledRecovery = ModelRunSchema.parse({
      ...failedComparison,
      status: "cancelled",
      evaluationProgress: {
        ...failedComparison.evaluationProgress!,
        stage: "candidate_adaptation",
      },
      failure: "Benchmark cancelled by operator.",
    });
    const resumedRecovery = ModelRunSchema.parse({
      ...cancelledRecovery,
      status: "running",
      failure: null,
      completedAt: null,
      updatedAt: "2026-08-10T00:02:00.000Z",
    });
    expect(isCheckpointResumeTransition(cancelledRecovery, resumedRecovery)).toBe(true);
  });

  test("reconciles only interrupted Harness Refiner evaluations", async () => {
    const harnessRun = runningEvaluationRun();
    const otherEvaluation = ModelRunSchema.parse({
      ...harnessRun,
      id: "model_run_other_evaluation",
      evaluation: {
        ...harnessRun.evaluation!,
        benchmarkId: "other-benchmark",
      },
    });
    const saveModelRun = vi.fn(async (value: typeof harnessRun) => value);
    const service = createHarnessRefinerBenchmarkService({
      store: {
        listModelRuns: vi.fn(async () => [harnessRun, otherEvaluation]),
        saveModelRun,
      },
      now: () => "2026-08-10T00:01:00.000Z",
    } as never);

    expect(await service.reconcileInterrupted()).toBe(1);
    expect(saveModelRun).toHaveBeenCalledOnce();
    expect(saveModelRun.mock.calls[0]?.[0]).toMatchObject({
      id: harnessRun.id,
      status: "failed",
    });
  });
});
