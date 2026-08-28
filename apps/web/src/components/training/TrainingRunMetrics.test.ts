import { describe, expect, it } from "vitest";

import type { TrainingRunDetail } from "@openpond/contracts";

import { eventSeries } from "./TrainingRunMetrics";

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
