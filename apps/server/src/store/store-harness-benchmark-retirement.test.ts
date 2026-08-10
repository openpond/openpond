import { ModelRunSchema } from "@openpond/contracts";
import { describe, expect, test } from "vitest";

import { retireLegacyHarnessBenchmarkRun } from "./store-harness-benchmark-retirement.js";

describe("legacy Harness Refiner benchmark retirement", () => {
  test("converts the retired smoke/full payload into valid failed history", () => {
    const legacy = {
      schemaVersion: "openpond.modelRun.v1",
      id: "legacy-run",
      modelId: "model-1",
      modelVersionId: "version-1",
      profileId: "profile-1",
      kind: "evaluation",
      status: "succeeded",
      method: null,
      destinationId: null,
      taskset: { id: "taskset-1", revision: 1, contentHash: "0".repeat(64) },
      harnessRelease: null,
      quote: null,
      evaluation: {
        benchmarkId: "harness-refiner",
        mode: "smoke",
        model: { providerId: "openpond", modelId: "openpond-chat" },
        upstreamModel: {
          providerId: "deepseek",
          modelId: "deepseek-v4-pro",
          revision: null,
        },
        reasoningEffort: "high",
        seeds: [17],
        repetitions: 1,
        maximumSpendUsd: 2,
      },
      evaluationProgress: { stage: "comparison", completedAttempts: 6, totalAttempts: 6 },
      reward: null,
      receipt: {
        attempts: [
          { phase: "baseline", taskId: "held-out-1" },
          { phase: "adaptation", taskId: "adaptation-1" },
          { phase: "candidate", taskId: "held-out-1" },
        ],
      },
      adapterArtifactLineageId: null,
      failure: null,
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      updatedAt: "2026-08-09T01:00:00.000Z",
    };

    const retired = ModelRunSchema.parse(retireLegacyHarnessBenchmarkRun(legacy));

    expect(retired).toMatchObject({
      status: "failed",
      receipt: null,
      evaluation: {
        upstreamModel: { revision: "legacy-unresolved" },
        attemptPlan: [
          { stage: "baseline", attemptCount: 1 },
          { stage: "adaptation", attemptCount: 1 },
          { stage: "candidate_adaptation", attemptCount: 1 },
          { stage: "candidate", attemptCount: 1 },
        ],
      },
    });
    expect(retired.evaluation).not.toHaveProperty("mode");
  });
});
