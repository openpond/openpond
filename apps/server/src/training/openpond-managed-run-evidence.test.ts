import { describe, expect, test } from "vitest";

import { parseManagedJobDetail } from "./openpond-managed-run-evidence.js";

describe("managed run evidence", () => {
  test("preserves structured learned-reward lineage from hosted trajectories", () => {
    const timestamp = "2026-08-25T20:08:24.000Z";
    const detail = parseManagedJobDetail({
      job: {
        id: "job-1",
        state: "completed",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      trajectories: [{
        id: "trajectory-1",
        groupId: "group-1",
        rolloutId: "rollout-1",
        policyVersion: 0,
        rewardEligible: true,
        reward: "0.603131",
        rewardComponents: {
          learnedReward: {
            score: 0.6031309366226196,
            rewardModelVersion: { id: "reward-v1", contentHash: "a".repeat(64) },
            rewardComposerRelease: { id: "composer-v1", contentHash: "b".repeat(64) },
          },
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    });

    expect(detail.trajectories[0]?.rewardComponents.learnedReward).toMatchObject({
      score: 0.6031309366226196,
      rewardModelVersion: { id: "reward-v1" },
      rewardComposerRelease: { id: "composer-v1" },
    });
  });
});
