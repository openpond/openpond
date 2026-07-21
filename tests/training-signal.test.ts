import { describe, expect, test } from "vitest";
import {
  BaselineReportSchema,
  selectPreferredRftSignalReport,
  type BaselineReport,
} from "../packages/contracts/src";

const match = {
  split: "train" as const,
  taskCount: 16,
  attemptsPerTask: 8,
  selectionSeed: 17,
  selectionStrategy: "rft_easy_curriculum_v1" as const,
  model: {
    providerId: "fireworks",
    modelId: "accounts/fireworks/models/qwen3-0p6b",
  },
  sampling: {
    maxOutputTokens: 512,
    temperature: 0.8,
    topP: 0.95,
  },
};

function report(input: {
  id: string;
  createdAt: string;
  passed: boolean;
  mixedRewardGroups: number;
}): BaselineReport {
  return BaselineReportSchema.parse({
    schemaVersion: "openpond.baselineReport.v1",
    id: input.id,
    tasksetId: "taskset_dapo_math",
    tasksetHash: "tasksethash",
    graderSetHash: "graderset",
    attemptRefs: [`attempt_${input.id}`],
    gradeRefs: [`grade_${input.id}`],
    passAtK: { "1": 0.25 },
    reward: { count: 128, mean: 0.25, min: 0, max: 1, variance: 0.1875 },
    failureClusters: {},
    totalCostUsd: 0.67,
    userInterventions: 0,
    hackingChecksPassed: true,
    leakageChecksPassed: true,
    scope: {
      ...match,
      taskIdsHash: "selectedtaskshash",
    },
    rftSignal: {
      requiredMixedRewardGroups: 4,
      mixedRewardGroups: input.mixedRewardGroups,
      allCorrectRewardGroups: 1,
      allIncorrectRewardGroups: 10,
      unscoredGroups: 0,
      infrastructureFailures: 0,
      eligibleAttempts: 128,
      correctAttempts: 27,
      incorrectAttempts: 101,
      parseableAttempts: 87,
      passed: input.passed,
    },
    createdAt: input.createdAt,
  });
}

describe("RFT signal receipt selection", () => {
  test("keeps an aligned passing receipt over a newer failed duplicate", () => {
    const passing = report({
      id: "baseline_passing",
      createdAt: "2026-07-20T23:48:15.687Z",
      passed: true,
      mixedRewardGroups: 5,
    });
    const newerFailed = report({
      id: "baseline_failed_duplicate",
      createdAt: "2026-07-20T23:51:28.661Z",
      passed: false,
      mixedRewardGroups: 3,
    });

    expect(selectPreferredRftSignalReport([newerFailed, passing], match)?.id)
      .toBe(passing.id);
  });

  test("uses the newest aligned receipt when none passed", () => {
    const older = report({
      id: "baseline_failed_older",
      createdAt: "2026-07-20T23:30:44.167Z",
      passed: false,
      mixedRewardGroups: 0,
    });
    const newer = report({
      id: "baseline_failed_newer",
      createdAt: "2026-07-20T23:38:49.872Z",
      passed: false,
      mixedRewardGroups: 1,
    });

    expect(selectPreferredRftSignalReport([older, newer], match)?.id)
      .toBe(newer.id);
  });
});
