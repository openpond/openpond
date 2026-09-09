import { describe, expect, it } from "vitest";

import { managedTrainingEvidenceFromPublic } from "./openpond-managed-training-evidence.js";

describe("managed training evidence projection", () => {
  it("publishes reward spread, skipped groups, movement, duration, and GPU time", () => {
    const evidence = managedTrainingEvidenceFromPublic({
      job: {
        id: "managed-job-evidence",
        state: "succeeded",
        accruedSpendUsd: 1.25,
        rolloutProgress: {
          groupsCompleted: 3,
          groupsTarget: 3,
          optimizerUpdatesApplied: 2,
          optimizerUpdatesSkipped: 1,
        },
      } as never,
      events: [
        { type: "rollout_metric", data: { metricKind: "rollout_trajectory", rewardEligible: true, reward: -0.5, inputTokens: 10, outputTokens: 4 } },
        { type: "rollout_metric", data: { metricKind: "rollout_trajectory", rewardEligible: true, reward: 0.5, inputTokens: 12, outputTokens: 5 } },
        { type: "optimizer_metric", data: { adapterDeltaNorm: 0.125 } },
        { type: "gpu_allocation_state", data: { provider: "runpod", gpuType: "A100", gpuCount: 2, hourlyCostUsd: 1.5 } },
      ] as never,
      outputs: {
        outputs: [
          { id: "baseline", contentHash: "a".repeat(64), kind: "evaluation", metadata: { kind: "baseline", policyVersion: 0, score: 1, threshold: 0, passed: true, metrics: { taskCount: 1 } } },
          { id: "candidate", contentHash: "b".repeat(64), kind: "evaluation", metadata: { kind: "candidate", policyVersion: 1, score: 0.8, threshold: 0, passed: true, metrics: { taskCount: 20, targetTaskCount: 20 } } },
        ],
        receipt: { spendUsd: 1.25, durationSeconds: 90 },
      } as never,
      syncedAt: "2026-09-01T12:00:00.000Z",
    });

    expect(evidence).toMatchObject({
      schemaVersion: "openpond.managedTrainingRunEvidence.v2",
      progress: { committedOptimizerSteps: 2, skippedOptimizerSteps: 1 },
      reward: {
        finalMean: 0,
        variance: 0.25,
        minimum: -0.5,
        maximum: 0.5,
        distinctValueCount: 2,
        noSignalGroupCount: 1,
      },
      resource: { durationSeconds: 90, gpuSeconds: 180 },
      movement: { adapterDeltaNorm: 0.125 },
      evaluations: [
        { reference: { id: "baseline", contentHash: "a".repeat(64) }, kind: "baseline", taskCount: 1, targetTaskCount: null },
        { reference: { id: "candidate", contentHash: "b".repeat(64) }, kind: "candidate", taskCount: 20, targetTaskCount: 20 },
      ],
    });
  });
});
