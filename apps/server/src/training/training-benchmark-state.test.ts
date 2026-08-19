import type { ModelRun } from "@openpond/contracts";
import { describe, expect, test } from "vitest";

import { evaluationModelRunStatus } from "./training-benchmark-state.js";

describe("evaluation Model Run status", () => {
  test("includes lightweight progress and accounting for monitors", () => {
    const evaluationProgress = {
      stage: "adaptation" as const,
      completedAttempts: 1,
      totalAttempts: 40,
      accounting: {
        usage: {},
        observedSpendUsd: 0.01,
        attempts: [{ attemptId: "attempt-1" }],
      },
      evidenceSnapshot: null,
    };
    const status = evaluationModelRunStatus({
      id: "model-run-1",
      status: "running",
      evaluationProgress,
      reward: null,
      failure: null,
      receipt: null,
      updatedAt: "2026-08-19T00:00:00.000Z",
    } as unknown as ModelRun);

    expect(status).toMatchObject({
      runId: "model-run-1",
      state: "running",
      phase: "adaptation",
      progress: 1 / 40,
      evaluationProgress,
      reward: null,
    });
  });
});
