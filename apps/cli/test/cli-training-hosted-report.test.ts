import { describe, expect, test } from "vitest";
import { TrainingJobSchema, TrainingJobEventSchema, TrainingJobOutputsSchema } from "openpond-sdk/training";
import { buildHostedTrainingReport } from "../src/cli/training-hosted-report";
import { parseHostedServingReportEvidence } from "../src/cli/training-hosted-serving-report";

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
  // Failure story: a completed checkpoint-only reload is called training and
  // its native cleanup is hidden, or another workspace's attestation is borrowed.
  test("reports verified checkpoint-only mode and native custody without inventing a public receipt", () => {
    const evaluation = { ...job, state: "cancelled" as const, phase: "cancelled",
      terminalReason: "checkpoint_evaluation_complete",
      rolloutProgress: { groupsCompleted: 0, groupsTarget: 0, optimizerUpdatesApplied: 0, optimizerUpdatesSkipped: 0 } };
    const inspection = { job: {
      job: { id: job.id, teamId: job.teamId, version: 9, targetGroups: 0, completedGroups: 0,
        optimizerUpdatesApplied: 0, optimizerUpdatesSkipped: 0, currentPolicyVersion: 2,
        canonicalPublishState: "skipped", publicSubmission: null,
        cleanupAttestation: { attestedAt: end, receiptSha256: "b".repeat(64), activeClaims: 0,
          liveSandboxes: 0, activeCapabilities: 0, activeReservations: 0, liveProviderStorage: 0, liveProviderWorkers: 0 } },
      resources: [{ kind: "worker_command", externalId: "serving-soak-source", metadata: {
        mode: "frozen_evaluation", target: "checkpoint", sourceJobId: "source-job", checkpointId: "checkpoint-2",
        policyVersion: 2, adapterSha256: "c".repeat(64), privatePrompt: "must not enter report" } }],
      trainingSteps: [], rolloutGroups: [], checkpoints: [], artifacts: [],
    } };
    const evidence = parseHostedServingReportEvidence(inspection, evaluation);
    const report = buildHostedTrainingReport({ job: evaluation, servingEvidence: evidence, events: [], outputs,
      versionBeforeRead: 3, generatedAt: end });
    expect(report.job.executionMode).toBe("frozen_evaluation");
    expect(report.job.serving?.checkpointId).toBe("checkpoint-2");
    expect(report.cleanup).toMatchObject({ executionReceiptAvailable: false, nativeAttestationAvailable: true, complete: true });
    expect(report.progress.currentExecution.optimizerUpdatesApplied).toBe(0);
    expect(report.findings.map(finding => finding.code)).toContain("checkpoint_evaluation_complete");
    expect(report.findings.map(finding => finding.code)).not.toContain("no_recorded_trajectories");
    expect(JSON.stringify(report)).not.toContain("must not enter report");
    expect(() => parseHostedServingReportEvidence(inspection, { ...evaluation, teamId: "foreign" })).toThrow("different job or workspace");
    expect(() => buildHostedTrainingReport({ job: { ...evaluation, id: "foreign" }, servingEvidence: evidence,
      events: [], outputs, versionBeforeRead: 3, generatedAt: end })).toThrow("different job or workspace");
    const live = structuredClone(inspection);
    live.job.job.cleanupAttestation.liveSandboxes = 1;
    expect(buildHostedTrainingReport({ job: evaluation, servingEvidence: parseHostedServingReportEvidence(live, evaluation),
      events: [], outputs, versionBeforeRead: 3, generatedAt: end }).cleanup.complete).toBe(false);
    const unpublished = { job: { ...inspection.job,
      job: { ...inspection.job.job, cleanupAttestation: null } } };
    expect(buildHostedTrainingReport({ job: evaluation, servingEvidence: parseHostedServingReportEvidence(unpublished, evaluation),
      events: [], outputs, versionBeforeRead: 3, generatedAt: end }).cleanup.complete).toBeNull();

    // Merged reloads have no active adapter. Their final signed delta must still
    // identify this exact source checkpoint, without exposing storage metadata.
    const artifact = { id: "merged-artifact", contentHash: "d".repeat(64) };
    const mergedMetadata = { ...inspection.job.resources[0]!.metadata, adapterSha256: null, artifact,
      derivedBackbone: { planSha256: "e".repeat(64), plan: { deltas: [{ sourceJobId: "source-job",
        checkpointId: "checkpoint-2", artifact, objectRef: "r2://private-storage/do-not-report" }] } } };
    const mergedInspection = (metadata: unknown = mergedMetadata) => ({ job: { ...inspection.job,
      resources: [{ ...inspection.job.resources[0]!, metadata }] } });
    const mergedEvidence = parseHostedServingReportEvidence(mergedInspection(), evaluation);
    const mergedReport = buildHostedTrainingReport({ job: evaluation, servingEvidence: mergedEvidence,
      events: [], outputs, versionBeforeRead: 3, generatedAt: end });
    expect(mergedReport.job.serving).toMatchObject({ representation: "merged_backbone", adapterSha256: null,
      backbonePlanSha256: "e".repeat(64), checkpointId: "checkpoint-2", artifact });
    expect(JSON.stringify(mergedReport)).not.toContain("private-storage");
    expect(JSON.stringify(mergedReport)).not.toContain("derivedBackbone");
    for (const changed of [
      { ...mergedMetadata, checkpointId: "foreign-checkpoint" },
      { ...mergedMetadata, sourceJobId: "foreign-source" },
      { ...mergedMetadata, artifact: { ...artifact, id: "foreign-artifact" } },
      { ...mergedMetadata, artifact: { ...artifact, contentHash: "f".repeat(64) } },
      { ...mergedMetadata, adapterSha256: "c".repeat(64) },
      { ...mergedMetadata, mode: "load_test" },
    ]) expect(() => parseHostedServingReportEvidence(mergedInspection(changed), evaluation)).toThrow("checkpoint identity mismatch");
    expect(() => parseHostedServingReportEvidence(mergedInspection({ ...mergedMetadata,
      derivedBackbone: { ...mergedMetadata.derivedBackbone, plan: { deltas: [] } } }), evaluation)).toThrow();
  });

  // Failure story: an inherited optimizer update is charged against the new
  // run's time/cost even before that run performs any optimizer work.
  test("separates verified inherited progress from this execution's efficiency", () => {
    const source = TrainingJobSchema.parse({ ...job, id: "source-job", state: "cancelled",
      rolloutProgress: { groupsCompleted: 1, groupsTarget: 4, optimizerUpdatesApplied: 1, optimizerUpdatesSkipped: 0 } });
    const recovered = TrainingJobSchema.parse({ ...job,
      recovery: { sourceJobId: source.id, checkpointId: "checkpoint-1", policyVersion: 1, completedGroups: 1, optimizerMode: "continue" },
      rolloutProgress: source.rolloutProgress });
    const report = buildHostedTrainingReport({ job: recovered, recoverySourceJob: source, events: [], outputs, versionBeforeRead: 3, generatedAt: end });
    expect(report.progress.inherited.optimizerUpdatesApplied).toBe(1);
    expect(report.progress.currentExecution.optimizerUpdatesApplied).toBe(0);
    expect(report.throughput.appliedUpdatesPerWallHour).toBe(0);
    expect(report.costs.perAppliedUpdateUsd).toBeNull();
    expect(report.findings.map(finding => finding.code)).not.toContain("optimizer_event_coverage_incomplete");
    const updated = buildHostedTrainingReport({
      job: { ...recovered, rolloutProgress: { ...recovered.rolloutProgress, groupsCompleted: 2, optimizerUpdatesApplied: 2 } },
      recoverySourceJob: source, events: [event("new-update", { metricKind: "policy_optimization" }, "optimizer_metric")],
      outputs, versionBeforeRead: 3, generatedAt: end,
    });
    expect(updated.progress.currentExecution.optimizerUpdatesApplied).toBe(1);
    expect(updated.throughput.appliedUpdatesPerWallHour).toBe(60);
    expect(updated.costs.perAppliedUpdateUsd).toBe(6);
    expect(() => buildHostedTrainingReport({ job: recovered, recoverySourceJob: { ...source, teamId: "other-team" }, events: [], outputs, versionBeforeRead: 3, generatedAt: end })).toThrow("terminal source");
    expect(() => buildHostedTrainingReport({ job: recovered, events: [], outputs, versionBeforeRead: 3, generatedAt: end })).toThrow("terminal source");
  });

  // Failure story: native graceful-stop recovery succeeds, but the public source
  // projects as succeeded and its inherited work makes the official report fail.
  test("reports recovery from a completed partial source without accepting a completed full workload", () => {
    const source = TrainingJobSchema.parse({ ...job, id: "graceful-source", progress: 0.5,
      rolloutProgress: { groupsCompleted: 2, groupsTarget: 4, optimizerUpdatesApplied: 1, optimizerUpdatesSkipped: 1 } });
    const recovered = TrainingJobSchema.parse({ ...job,
      recovery: { sourceJobId: source.id, checkpointId: "checkpoint-1", policyVersion: 1, completedGroups: 2, optimizerMode: "continue" },
      rolloutProgress: { groupsCompleted: 4, groupsTarget: 4, optimizerUpdatesApplied: 2, optimizerUpdatesSkipped: 2 } });
    const report = (recoverySourceJob = source) => buildHostedTrainingReport({ job: recovered,
      recoverySourceJob, events: [], outputs, versionBeforeRead: 3, generatedAt: end });
    expect(report().progress.inherited).toMatchObject({ groupsCompleted: 2, optimizerUpdatesApplied: 1, optimizerUpdatesSkipped: 1 });
    expect(report().progress.currentExecution).toMatchObject({ groupsCompleted: 2, groupsTarget: 2,
      optimizerUpdatesApplied: 1, optimizerUpdatesSkipped: 1 });
    // Keep the other evidence identical so full completion alone must reject it.
    expect(() => report({ ...source, rolloutProgress: { ...source.rolloutProgress, groupsTarget: 2 } })).toThrow("terminal source");
    expect(() => report({ ...source, phase: "artifact_ready" })).toThrow("terminal source");
    expect(() => report({ ...source, rolloutProgress: { ...source.rolloutProgress, groupsTarget: 8 } })).toThrow("terminal source");
  });

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
