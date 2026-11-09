import { describe, expect, it } from "vitest";

import type { TrainingRunDetail } from "@openpond/contracts";
import type { TrainingJobEvent } from "openpond-sdk/training";
import { hostedTrainingMetricSeries } from "./hosted-training-metrics";

import {
  eventSeries,
  mergeRolloutRewardSeries,
  rolloutRewardSeries,
} from "./TrainingRunMetrics";
import {
  rolloutRewardGroups,
} from "./training-rollout-metrics";

describe("eventSeries", () => {
  // The hosted API reports committed fields in one optimizer event, rather
  // than a separate metricId/value event for each chart.
  it("reads hosted optimizer and supervised telemetry without charting failed rewards", () => {
    const events = [
      { type: "optimizer_metric", sequence: 0, data: { metricKind: "policy_optimization", step: 2,
        policyLoss: 0.4, learningRate: 0.00003, meanReward: null } },
      { type: "optimizer_metric", sequence: 1, data: { metricKind: "policy_optimization", step: 2, policyLoss: 0.3 } },
      { type: "metric", sequence: 2, data: { metricKind: "sft_step", step: 1, loss: 1.2, meanTokenAccuracy: 0.6 } },
      { type: "rollout_metric", sequence: 3, data: { rolloutIndex: 8, reward: 0, rewardEligible: false } },
      { type: "rollout_metric", sequence: 4, data: { rolloutIndex: 9, reward: 0, rewardEligible: true } },
    ] as unknown as TrainingJobEvent[];
    const series = new Map(hostedTrainingMetricSeries(events).map(metric => [metric.id, metric]));
    expect(series.get("optimizer.policy_loss")?.points).toEqual([{ step: 2, value: 0.3 }]);
    expect(series.get("optimizer.learning_rate")).toMatchObject({ format: "scientific", points: [{ step: 2, value: 0.00003 }] });
    expect(series.get("optimizer.loss")?.points).toEqual([{ step: 1, value: 1.2 }]);
    expect(series.get("train.token_accuracy")).toMatchObject({ format: "percent", points: [{ step: 1, value: 0.6 }] });
    expect(series.has("optimizer.reward")).toBe(false);
    expect(series.get("rollout.reward")?.points).toEqual([{ step: 9, value: 0 }]);
  });

  // An infrastructure failure is operational evidence, not a model score of
  // zero. Keep a genuine eligible zero while excluding failed placeholders.
  it("separates infrastructure-only groups from genuine zero rewards", () => {
    const detail = { events: [
      { type: "metric", sequence: 0, payload: { metricKind: "rollout_trajectory", rolloutGroupId: "failed",
        reward: 0, rewardEligible: false, failureCode: "worker_lost", inputTokens: 10, outputTokens: 0 } },
      { type: "metric", sequence: 1, payload: { metricKind: "rollout_trajectory", rolloutGroupId: "scored",
        reward: 0, rewardEligible: true, inputTokens: 12, outputTokens: 2 } },
    ] } as unknown as TrainingRunDetail;
    const series = new Map(eventSeries(detail.events).map(metric => [metric.id, metric.points]));
    expect(series.get("rollout.reward")).toEqual([{ step: 1, value: 0 }]);
    expect(series.get("reward.variance")).toEqual([{ step: 1, value: 0 }]);
    expect(series.get("reward.best")).toEqual([{ step: 1, value: 0 }]);
    expect(series.get("attempt.failure_count")).toEqual([{ step: 0, value: 1 }, { step: 1, value: 0 }]);
    expect(series.get("tokens.input")).toEqual([{ step: 0, value: 10 }, { step: 1, value: 12 }]);
  });

  it("summarizes reward spread, best reward, validity, and retries by rollout group", () => {
    const detail = {
      events: [
        {
          type: "metric",
          sequence: 0,
          payload: {
            metricKind: "rollout_trajectory",
            rolloutGroupId: "group-1",
            reward: 0.2,
            rewardEligible: true,
            attempt: 1,
            inputTokens: 10,
            outputTokens: 2,
          },
        },
        {
          type: "metric",
          sequence: 1,
          payload: {
            metricKind: "rollout_trajectory",
            rolloutGroupId: "group-1",
            reward: 0.8,
            rewardEligible: true,
            attempt: 2,
            inputTokens: 12,
            outputTokens: 3,
          },
        },
      ],
    } as unknown as TrainingRunDetail;

    const series = new Map(
      eventSeries(detail.events).map((metric) => [metric.id, metric.points]),
    );

    expect(series.get("reward.variance")?.[0]?.step).toBe(0);
    expect(series.get("reward.variance")?.[0]?.value).toBeCloseTo(0.09);
    expect(series.get("reward.best")).toEqual([{ step: 0, value: 0.8 }]);
    expect(series.get("attempt.valid_rate")).toEqual([{ step: 0, value: 1 }]);
    expect(series.get("attempt.retry_count")).toEqual([{ step: 0, value: 1 }]);
  });
});

describe("rolloutRewardGroups", () => {
  it("keeps rollout groups continuous and correlates optimizer outcomes without using rollout indexes as steps", () => {
    const detail = {
      events: [
        trajectoryEvent({
          id: "trajectory-40",
          groupId: "group-10",
          groupIndex: 10,
          rolloutIndex: 40,
          policyVersion: 8,
          reward: 0.2,
          taskId: "task-b",
          rewardComponents: {
            accuracy: { score: 1, passed: true },
            format: 0,
          },
        }),
        trajectoryEvent({
          id: "trajectory-41",
          groupId: "group-10",
          groupIndex: 10,
          rolloutIndex: 41,
          policyVersion: 8,
          reward: 0.8,
          taskId: "task-b",
        }),
        {
          id: "skip-10",
          type: "metric",
          payload: {
            metricKind: "optimizer_disposition",
            rolloutGroupId: "group-10",
            remotePhase: "skipped_no_signal",
          },
        },
        trajectoryEvent({
          id: "trajectory-44",
          groupId: "group-11",
          groupIndex: 11,
          rolloutIndex: 44,
          policyVersion: 8,
          reward: 0.4,
        }),
        {
          id: "update-12",
          type: "metric",
          payload: {
            metricKind: "policy_optimization",
            step: 12,
          },
        },
      ],
    } as unknown as TrainingRunDetail;

    const groups = rolloutRewardGroups(detail.events, [
      {
        id: "task-a",
        split: "train",
        clusterKey: "family-a",
        input: { prompt: "Inspect the first training scenario." },
        metadata: {},
      },
      {
        id: "task-b",
        split: "train",
        clusterKey: "family-b",
        input: { prompt: "Resolve the reported customer return request.\n\nCustomer identity follows." },
        metadata: {},
      },
    ] as never);

    expect(groups.map((group) => group.groupIndex)).toEqual([10, 11]);
    expect(groups[0]).toMatchObject({
      id: "group-10",
      mean: 0.5,
      minimum: 0.2,
      maximum: 0.8,
      optimizerDisposition: "skipped",
      optimizerStep: null,
      taskId: "task-b",
      taskLabel: "Resolve the reported customer return request.",
      taskFamily: "family-b",
    });
    expect(groups[0]?.trajectories[0]?.rolloutIndex).toBe(40);
    expect(groups[0]?.trajectories[0]?.components).toEqual([
      {
        id: "accuracy",
        label: "Accuracy",
        score: 1,
        passed: true,
        feedback: null,
      },
      {
        id: "format",
        label: "Format",
        score: 0,
        passed: null,
        feedback: null,
      },
    ]);
    expect(groups[1]).toMatchObject({
      id: "group-11",
      optimizerDisposition: "applied",
      optimizerStep: 12,
      taskId: "task-b",
      taskFamily: "family-b",
    });
    expect(rolloutRewardSeries(groups)).toMatchObject({
      id: "optimizer.reward",
      label: "Mean reward",
      xLabel: "rollout group",
      points: [
        { step: 1, value: 0.5 },
        { step: 2, value: 0.4 },
      ],
    });
    const merged = mergeRolloutRewardSeries([
      { id: "optimizer.reward", label: "Mean reward", points: [{ step: 1, value: 0.3 }] },
      { id: "rollout.reward", label: "Rollout reward", points: [{ step: 40, value: 0.2 }] },
      { id: "optimizer.kl", label: "Policy update KL", points: [{ step: 1, value: 0.01 }] },
    ], groups);
    expect(merged.filter((series) => series.id.includes("reward"))).toEqual([
      expect.objectContaining({
        id: "optimizer.reward",
        label: "Mean reward",
        points: [
          { step: 1, value: 0.5 },
          { step: 2, value: 0.4 },
        ],
      }),
    ]);
  });
});

function trajectoryEvent(input: {
  id: string;
  groupId: string;
  groupIndex: number;
  rolloutIndex: number;
  policyVersion: number;
  reward: number;
  taskId?: string;
  rewardComponents?: Record<string, unknown>;
}) {
  return {
    id: input.id,
    type: "metric",
    payload: {
      metricKind: "rollout_trajectory",
      rolloutGroupId: input.groupId,
      rolloutGroupIndex: input.groupIndex,
      rolloutIndex: input.rolloutIndex,
      policyVersion: input.policyVersion,
      taskId: input.taskId,
      reward: input.reward,
      rewardEligible: true,
      rewardComponents: input.rewardComponents,
    },
  };
}
