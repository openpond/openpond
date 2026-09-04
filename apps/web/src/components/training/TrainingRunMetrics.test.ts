import { describe, expect, it } from "vitest";

import type { TrainingRunDetail } from "@openpond/contracts";

import { eventSeries } from "./TrainingRunMetrics";
import {
  rolloutRewardGroups,
  summarizeRolloutRewardProgress,
} from "./training-rollout-metrics";

describe("eventSeries", () => {
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
  });
});

describe("summarizeRolloutRewardProgress", () => {
  it("keeps the planned task count distinct from completed and partial results", () => {
    expect(summarizeRolloutRewardProgress(16, {
      completedGroups: 15,
      targetGroups: 26,
    })).toEqual({
      observedTasks: 16,
      completedTasks: 15,
      activeTasks: 1,
      notStartedTasks: 10,
      targetTasks: 26,
    });

    expect(summarizeRolloutRewardProgress(26, {
      completedGroups: 26,
      targetGroups: 26,
    })).toEqual({
      observedTasks: 26,
      completedTasks: 26,
      activeTasks: 0,
      notStartedTasks: 0,
      targetTasks: 26,
    });
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
