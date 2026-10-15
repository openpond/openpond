import { describe, expect, test } from "vitest";
import { TrainingJobSchema, TrainingJobEventSchema, TrainingJobOutputsSchema } from "openpond-sdk/training";
import { buildHostedTrainingReport } from "../src/cli/training-hosted-report";

const start = "2026-10-13T20:00:00.000Z";
const end = "2026-10-13T20:01:00.000Z";
const job = TrainingJobSchema.parse({
  schemaVersion: "openpond.trainingJob.v2", id: "job-1", teamId: "team-1",
  kind: "policy_optimize", modelProjectId: "model-1", portableProjectId: "portable-1",
  sourceProjectRevision: 1, submissionHash: "a".repeat(64), state: "succeeded", phase: "completed",
  version: 3, progress: 1, accruedSpendUsd: 6, terminalReason: null,
  rolloutProgress: { groupsCompleted: 2, groupsTarget: 2, optimizerUpdatesApplied: 1, optimizerUpdatesSkipped: 1 },
  createdAt: start, updatedAt: end, completedAt: end,
});
const outputs = TrainingJobOutputsSchema.parse({ schemaVersion: "openpond.trainingJobOutputs.v2", outputs: [], receipt: null });
function event(id: string, data: Record<string, unknown>, type = "rollout_metric") {
  return TrainingJobEventSchema.parse({
    schemaVersion: "openpond.trainingJobEvent.v2", id, jobId: job.id, sequence: 1,
    type, phase: "completed", message: "private prompt must not enter report", data, createdAt: start,
  });
}

describe("hosted report accounting and learning evidence", () => {
  // Failure story: repeated event snapshots inflate cost denominators; allocation
  // costs get added to job costs; metadata or ineligible-only fields get presented
  // as grader components; ineligible rewards hide a no-signal problem.
  test("keeps accounting views separate and aggregates only eligible recorded evidence", () => {
    const first = event("trajectory-1", { metricKind: "rollout_trajectory", rolloutGroupId: "group-1", rewardEligible: true, reward: 0, terminalClass: "policy", inputTokens: 10, outputTokens: 2,
      rewardComponents: { reward: 0, scope: 0.5, executionTiming: { totalRolloutSeconds: 3 }, rewardCompositionHash: "private prompt hash", workOutcome: { status: "complete" }, nonfinite: Number.POSITIVE_INFINITY } });
    const events = [first, first,
      event("trajectory-2", { metricKind: "rollout_trajectory", rolloutGroupId: "group-1", rewardEligible: true, reward: 1, terminalClass: "policy" }),
      event("trajectory-3", { metricKind: "rollout_trajectory", rolloutGroupId: "group-2", rewardEligible: true, reward: 0, terminalClass: "policy" }),
      event("trajectory-4", { metricKind: "rollout_trajectory", rolloutGroupId: "group-2", rewardEligible: false, reward: 99, terminalClass: "infrastructure", rewardComponents: { ineligibleOnly: 99 } }),
      event("skipped-2", { rolloutGroupId: "group-2" }, "optimizer_skipped_no_signal"),
      event("allocation-1", { metricKind: "gpu_allocation", allocationId: "allocation-1", accruedGpuUsd: 4, accruedGpuSeconds: 45 }),
      event("infer-1", { metricKind: "inference_command", timings: { commandTotalSeconds: 5, vllmRequestSeconds: 4, vllmPrefillSeconds: 2, vllmDecodeSeconds: 2 } }, "infer"),
      event("infer-2", { metricKind: "inference_command", timings: {} }, "infer"),
    ];
    const report = buildHostedTrainingReport({ job, events, outputs, versionBeforeRead: 3, generatedAt: end });
    expect(report.trajectories.recorded).toBe(4);
    expect(report.trajectories.eligibleRewards.mean).toBeCloseTo(1 / 3);
    expect(report.trajectories.groups.find(group => group.groupId === "group-1")?.rewardStd).toBe(0.5);
    expect(report.trajectories.groups.find(group => group.groupId === "group-2")?.allRecordedRewardsEqual).toBe(false);
    expect(report.learning.noSignalGroupsRecorded).toBe(1);
    expect(report.costs.jobAccruedSpendUsd).toBe(6);
    expect(report.costs.allocationGpuUsd.total).toBe(4);
    expect(report.costs.perRecordedEligibleTrajectoryUsd).toBe(2);
    expect(report.costs.physicalInvoiceTotalUsd).toBeNull();
    expect(report.wall.elapsedSeconds).toBe(60);
    expect(report.timings.inferenceSeconds.vllmRequestSeconds).toMatchObject({ total: 4, observations: 1, missing: 1 });
    expect(report.learning.entropy.mean).toBeNull();
    expect(Object.keys(report.trajectories.rewardComponents)).toEqual(["reward", "scope"]);
    expect(report.trajectories.rewardComponents.scope).toMatchObject({ observations: 1, missing: 2, mean: 0.5 });
    expect(report.findings.map(finding => finding.code)).toContain("reward_component_binding_unverified");
    const aggregateOnly = buildHostedTrainingReport({ job, events: [{ ...first, data: { ...first.data, rewardComponents: { reward: 0, executionTiming: {}, rewardCompositionHash: "private prompt hash", workOutcome: {} } } }], outputs, versionBeforeRead: 3, generatedAt: end });
    expect(Object.keys(aggregateOnly.trajectories.rewardComponents)).toEqual(["reward"]);
    expect(aggregateOnly.findings.map(finding => finding.code)).toContain("per_grader_reward_breakdown_unavailable");
    expect(JSON.stringify(report)).not.toContain("private prompt");
  });

  // Failure story: a no-update qualification is presented as failed learning,
  // or evidence from another workspace/job is silently mixed into the report.
  test("preserves qualification and missing evidence, flags live changes, and rejects foreign evidence", () => {
    const qualification = { ...job, executionMode: "qualification" as const,
      rolloutProgress: { groupsCompleted: 1, groupsTarget: 1, optimizerUpdatesApplied: 0, optimizerUpdatesSkipped: 0 } };
    const report = buildHostedTrainingReport({ job: qualification, events: [], outputs, versionBeforeRead: 2, generatedAt: end });
    expect(report.costs.perAppliedUpdateUsd).toBeNull();
    expect(report.costs.perRecordedEligibleTrajectoryUsd).toBeNull();
    expect(report.timings.optimizerSeconds.totalTrainStepSeconds.total).toBeNull();
    expect(report.findings.map(finding => finding.code)).toContain("qualification_only");
    expect(report.findings.map(finding => finding.code)).toContain("job_changed_during_read");
    expect(() => buildHostedTrainingReport({ job, events: [{ ...event("foreign", {}), jobId: "other-job" }], outputs, versionBeforeRead: 3, generatedAt: end })).toThrow("different job or workspace");
  });
});
