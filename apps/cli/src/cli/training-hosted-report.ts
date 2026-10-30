import type { TrainingJob, TrainingJobEvent, TrainingJobOutputs } from "openpond-sdk/training";
import type { HostedServingReportEvidence } from "./training-hosted-serving-report";
import { code, counts, distributionStatistics, finite, nonnegative, populationStd, record, statistics, timingStatistics } from "./training-report-metrics";

const INFERENCE_TIMINGS = [
  "commandTotalSeconds", "requestPreparationSeconds", "vllmRequestSeconds",
  "vllmQueueSeconds", "vllmPrefillSeconds", "vllmDecodeSeconds",
  "vllmTimeToFirstTokenSeconds", "vllmInferenceSeconds", "tokenizationSeconds",
  "workerQueueSeconds", "workerBatchWaitSeconds",
] as const;
const OPTIMIZER_TIMINGS = [
  "inputPreparationSeconds", "parameterHashSeconds", "residentLoadSeconds",
  "oldAndReferenceForwardSeconds", "optimizerForwardBackwardSeconds",
  "postUpdateForwardSeconds", "checkpointSaveSeconds", "adapterSerializationSeconds",
  "adapterCompositionSeconds", "serializedAdapterVerificationSeconds",
  "optimizerStateSerializationSeconds", "deferredDiagnosticsSerializationSeconds", "totalTrainStepSeconds",
] as const;

/** Aggregate existing team-scoped evidence, including owner-checked serving metadata. The report does not
 * fetch trajectories, print event messages, infer physical bills, or add
 * overlapping phase durations to wall time. */
export function buildHostedTrainingReport(input: {
  job: TrainingJob;
  events: TrainingJobEvent[];
  outputs: TrainingJobOutputs;
  recoverySourceJob?: TrainingJob;
  servingEvidence?: HostedServingReportEvidence;
  versionBeforeRead: number;
  generatedAt: string;
}) {
  const { job, outputs } = input;
  const serving = input.servingEvidence;
  if (serving && (serving.jobId !== job.id || serving.teamId !== job.teamId)) {
    throw new Error("Hosted serving report evidence belongs to a different job or workspace.");
  }
  if (serving && Object.values(job.rolloutProgress).some(count => count !== 0)) {
    throw new Error("Hosted serving report cannot contain training progress.");
  }
  const cleanupComplete = serving?.cleanupComplete === null || !serving
    ? outputs.receipt?.cleanupComplete ?? null
    : serving.cleanupComplete && outputs.receipt?.cleanupComplete !== false;
  const source = input.recoverySourceJob;
  // Native recovery authorizes a completed bounded stop too. Public jobs expose
  // its succeeded/completed partial boundary, but do not expose the stop flag.
  const completedPartialSource = source?.state === "succeeded" && source.phase === "completed" &&
    source.rolloutProgress.groupsCompleted > 0 &&
    source.rolloutProgress.groupsCompleted < source.rolloutProgress.groupsTarget &&
    source.rolloutProgress.groupsTarget === job.rolloutProgress.groupsTarget;
  if (job.recovery && (!source || source.id !== job.recovery.sourceJobId || source.teamId !== job.teamId ||
      !source.completedAt || (!["failed", "cancelled"].includes(source.state) && !completedPartialSource) ||
      source.rolloutProgress.groupsCompleted !== job.recovery.completedGroups ||
      source.rolloutProgress.optimizerUpdatesApplied + source.rolloutProgress.optimizerUpdatesSkipped !== job.recovery.completedGroups)) {
    throw new Error("Hosted recovery report requires the unchanged terminal source run's progress.");
  }
  const inherited = job.recovery && source ? source.rolloutProgress : {
    groupsCompleted: 0, optimizerUpdatesApplied: 0, optimizerUpdatesSkipped: 0,
  };
  const currentExecution = {
    groupsCompleted: job.rolloutProgress.groupsCompleted - inherited.groupsCompleted,
    groupsTarget: job.rolloutProgress.groupsTarget - inherited.groupsCompleted,
    optimizerUpdatesApplied: job.rolloutProgress.optimizerUpdatesApplied - inherited.optimizerUpdatesApplied,
    optimizerUpdatesSkipped: job.rolloutProgress.optimizerUpdatesSkipped - inherited.optimizerUpdatesSkipped,
  };
  if (Object.values(currentExecution).some(value => value < 0)) {
    throw new Error("Hosted recovery source progress exceeds the recovered run's progress.");
  }
  if (input.events.length > 100_000) throw new Error("Hosted report exceeds 100,000 events.");
  if (input.events.some(event => event.jobId !== job.id) ||
      outputs.outputs.some(output => output.jobId !== job.id) ||
      outputs.receipt && (outputs.receipt.jobId !== job.id || outputs.receipt.teamId !== job.teamId)) {
    throw new Error("Hosted report evidence belongs to a different job or workspace.");
  }
  const eventById = new Map<string, TrainingJobEvent>();
  for (const event of input.events) {
    const previous = eventById.get(event.id);
    if (previous && previous.sequence === event.sequence && JSON.stringify(previous) !== JSON.stringify(event)) {
      throw new Error("Hosted report contains conflicting event snapshots.");
    }
    if (!previous || event.sequence >= previous.sequence) eventById.set(event.id, event);
  }
  const events = [...eventById.values()];
  const trajectories = events.filter(event => event.data.metricKind === "rollout_trajectory");
  const eligible = trajectories.filter(event => event.data.rewardEligible === true);
  const ineligible = trajectories.filter(event => event.data.rewardEligible === false);
  const scored = eligible.filter(event => finite(event.data.reward) !== null);
  const inference = events.filter(event => event.data.metricKind === "inference_command");
  const optimizer = events.filter(event => event.data.metricKind === "policy_optimization");
  const skipped = events.filter(event => event.type === "optimizer_skipped_no_signal");
  const allocations = events.filter(event => event.data.metricKind === "gpu_allocation");
  const workers = events.filter(event => event.data.metricKind === "physical_gpu_worker");
  const findings: Array<{ code: string; message: string }> = [];
  const add = (code: string, message: string) => findings.push({ code, message });
  if (job.recovery) add("checkpoint_recovery_reuses_progress", "Cumulative progress includes the source run; throughput and per-update cost use only this execution's new updates.");
  const jobRevisionStableDuringRead = input.versionBeforeRead === job.version;
  if (!jobRevisionStableDuringRead) add("job_changed_during_read", "The job changed during these reads; rerun for a stable snapshot.");
  if (!trajectories.length && !serving) add("no_recorded_trajectories", "No trajectory evidence is present; this report cannot assess model quality or learning.");
  if (ineligible.length) add("ineligible_trajectories", "Infrastructure-ineligible trajectories are excluded from reward statistics.");
  if (eligible.length !== scored.length) add("eligible_rewards_pending", "Some eligible trajectories have no finite grade yet.");
  if (skipped.length) add("no_signal_groups", "Recorded groups produced zero standardized advantage and skipped optimization; inspect reward/task quality before increasing the budget.");
  const qualification = job.executionMode === "qualification";
  if (qualification) add("qualification_only", "This run collects original-model evidence; optimizer updates were not requested.");
  if (serving) add("serving_only", "This run serves an existing checkpoint; optimizer work and model publication were not requested.");
  if (serving?.executionMode === "training_diagnostic")
    add("training_fit_only", "This diagnostic measures the original training cases; it provides no held-out generalization or promotion evidence.");
  if (serving?.executionMode === "training_diagnostic" && job.terminalReason === "training_diagnostic_complete")
    add("training_diagnostic_complete", "The training fit diagnostic finished and entered ordinary cleanup.");
  else if (serving?.executionMode === "frozen_evaluation" && job.terminalReason === "checkpoint_evaluation_complete") {
    add("checkpoint_evaluation_complete", "The frozen evaluation finished and entered its ordinary cancellation/cleanup lifecycle.");
  } else if (job.terminalReason) add("terminal_reason_present", "The job has a terminal reason; inspect official status/logs for its details.");
  if (!outputs.receipt && serving?.cleanupAttestation) {
    add("public_execution_receipt_unavailable", "Native custody is reported from the owner attestation; no public final execution receipt or reconciled invoice is available.");
  } else if (!outputs.receipt) add("execution_receipt_unavailable", "No final execution receipt is available; cleanup and reconciled execution evidence remain unverified here.");
  if (cleanupComplete === false) add("cleanup_incomplete", "Recorded cleanup evidence does not attest completed cleanup.");

  const groups = new Map<string, TrainingJobEvent[]>();
  for (const event of eligible) {
    const groupId = code(event.data.rolloutGroupId);
    if (!groupId) continue;
    const group = groups.get(groupId) ?? [];
    group.push(event);
    groups.set(groupId, group);
  }
  const groupRewards = [...groups].map(([groupId, rows]) => {
    const values = rows.map(row => finite(row.data.reward)).filter((value): value is number => value !== null);
    const std = populationStd(values);
    return {
      groupId,
      recordedEligible: rows.length,
      recordedScored: values.length,
      rewardMean: statistics(values).mean,
      rewardStd: std,
      allRecordedRewardsEqual: values.length >= 2 && std === 0,
      optimizerSkippedNoSignal: skipped.some(event => event.data.rolloutGroupId === groupId),
    };
  });
  const componentNames = new Set(scored.flatMap(event => Object.entries(record(event.data.rewardComponents))
    .filter(([key, value]) => code(key) && finite(value) !== null).map(([key]) => key)));
  const componentRewards = Object.fromEntries([...componentNames].sort().map(name => [
    name, statistics(scored.map(event => finite(record(event.data.rewardComponents)[name]))),
  ]));
  if (scored.length && ![...componentNames].some(name => name !== "reward")) {
    add("per_grader_reward_breakdown_unavailable", "Eligible aggregate rewards are recorded, but no separate finite numeric component fields are present. Per-grader coverage and scores are unavailable; missing breakdowns are not zero grades.");
  } else if (componentNames.size) {
    add("reward_component_binding_unverified", "Reward components summarize finite numeric event fields only. The reward field is aggregate; other fields are not established as individual grader scores without matching the frozen grader binding.");
  }
  const inferenceRows = inference.map(event => record(event.data.timings));
  const optimizerRows = optimizer.map(event => record(event.data.timings));
  if (inference.length && inferenceRows.some(row => nonnegative(row.vllmRequestSeconds) === null)) {
    add("inference_timing_incomplete", "Some inference commands lack request timing; missing measurements are not zero durations.");
  }
  if (optimizer.length < currentExecution.optimizerUpdatesApplied) {
    add("optimizer_event_coverage_incomplete", "Fewer optimizer events were returned than applied updates; report evidence may be incomplete.");
  }
  if (skipped.length < currentExecution.optimizerUpdatesSkipped) {
    add("no_signal_event_coverage_incomplete", "Fewer no-signal events were returned than skipped updates; group details may be incomplete.");
  }
  const end = Date.parse(job.completedAt ?? input.generatedAt);
  if (!Number.isFinite(end) || !Number.isFinite(Date.parse(input.generatedAt))) throw new Error("Hosted report timestamp is invalid.");
  const elapsedSeconds = Math.max(0, (end - Date.parse(job.createdAt)) / 1_000);
  const hourlyRate = (count: number) => elapsedSeconds > 0 ? count * 3_600 / elapsedSeconds : null;
  const outputTokens = statistics(trajectories.map(event => nonnegative(event.data.outputTokens)));
  const allocationById = new Map<string, TrainingJobEvent>();
  for (const event of allocations.sort((a, b) => a.sequence - b.sequence)) {
    const id = code(event.data.allocationId);
    if (id) allocationById.set(id, event);
  }
  const workerById = new Map<string, TrainingJobEvent>();
  for (const event of workers.sort((a, b) => a.sequence - b.sequence)) {
    const id = code(event.data.physicalWorkerId);
    if (id) workerById.set(id, event);
  }
  const terminal = job.completedAt !== null;
  return {
    schemaVersion: "openpond.trainingRunReport.v1",
    generatedAt: input.generatedAt,
    job: {
      id: job.id, teamId: job.teamId, submissionHash: job.submissionHash,
      kind: job.kind, executionMode: serving?.executionMode ?? (qualification ? "qualification" : "training"),
      state: job.state, phase: job.phase, version: job.version,
      terminalReasonPresent: job.terminalReason !== null,
      createdAt: job.createdAt, completedAt: job.completedAt,
      ...(job.recovery ? { recovery: job.recovery } : {}),
      ...(serving ? { serving: serving.source } : {}),
    },
    evidence: {
      jobRevisionStableDuringRead, versionBeforeRead: input.versionBeforeRead, versionAfterRead: job.version,
      readModel: "independent_authenticated_reads_not_an_atomic_snapshot",
      returnedEvents: input.events.length, uniqueEvents: events.length,
      scope: serving ? "public_events_and_authenticated_native_serving_metadata" : "returned_public_event_snapshot", terminal,
      ...(serving ? { nativeServingJobVersion: serving.nativeJobVersion } : {}),
      recoverySourceJobVersion: job.recovery ? source!.version : null,
      completeness: "Only recorded events are summarized; absent instrumentation is not proof of no work.",
    },
    progress: { ...job.rolloutProgress, currentExecution,
      inherited: { groupsCompleted: inherited.groupsCompleted,
        optimizerUpdatesApplied: inherited.optimizerUpdatesApplied,
        optimizerUpdatesSkipped: inherited.optimizerUpdatesSkipped } },
    wall: { elapsedSeconds, inferenceCommands: inference.length, optimizerEvents: optimizer.length },
    throughput: {
      recordedTrajectoriesPerWallHour: hourlyRate(trajectories.length),
      recordedEligibleTrajectoriesPerWallHour: hourlyRate(eligible.length),
      appliedUpdatesPerWallHour: hourlyRate(currentExecution.optimizerUpdatesApplied),
      recordedOutputTokensPerWallSecond: elapsedSeconds > 0 && outputTokens.total !== null ? outputTokens.total / elapsedSeconds : null,
      note: "Execution throughput includes startup, waits and cleanup, and excludes inherited updates; this is not engine decode tokens/second.",
    },
    trajectories: {
      recorded: trajectories.length, eligible: eligible.length, ineligible: ineligible.length,
      eligibilityUnknown: trajectories.length - eligible.length - ineligible.length,
      scoredEligible: scored.length, pendingEligibleGrades: eligible.length - scored.length,
      inputTokens: statistics(trajectories.map(event => nonnegative(event.data.inputTokens))),
      outputTokens,
      eligibleRewards: statistics(eligible.map(event => finite(event.data.reward))),
      rewardComponents: componentRewards,
      terminalClasses: counts(trajectories.map(event => code(event.data.terminalClass))),
      ineligibleTerminalClasses: counts(ineligible.map(event => code(event.data.terminalClass))),
      groups: groupRewards,
      groupCoverageNote: "Within-group statistics cover recorded eligible scores only; equal partial scores do not establish a completed no-signal group.",
    },
    failures: {
      commandErrorCodes: counts(events.map(event => code(event.data.errorCode))),
      outboxErrorCodes: counts(events.map(event => code(event.data.lastErrorCode))),
      providerFailureCodes: counts([...workerById.values()].map(event => code(event.data.failureCode))),
    },
    learning: {
      noSignalGroupsRecorded: skipped.length,
      samplingLogprobMae: statistics(optimizer.map(event => nonnegative(event.data.samplingLogprobMae))),
      entropy: statistics(optimizer.map(event => nonnegative(event.data.entropy))),
      gradientNorm: statistics(optimizer.map(event => nonnegative(event.data.gradientNorm))),
      behaviorPolicyKlPreUpdate: statistics(optimizer.map(event => nonnegative(event.data.behaviorPolicyKlPreUpdate))),
      baseOrReferenceKl: statistics(optimizer.map(event => nonnegative(event.data.kl))),
    },
    timings: {
      environmentSeconds: timingStatistics(trajectories.map(event => record(event.data.executionTiming)), [
        "initializationSeconds", "policySeconds", "environmentSeconds", "cleanupSeconds", "totalRolloutSeconds",
      ]),
      toolCalls: statistics(trajectories.map(event => nonnegative(record(event.data.executionTiming).toolCalls))),
      toolFailures: statistics(trajectories.map(event => nonnegative(record(event.data.executionTiming).toolFailures))),
      inferenceSeconds: timingStatistics(inferenceRows, INFERENCE_TIMINGS),
      optimizerSeconds: timingStatistics(optimizerRows, OPTIMIZER_TIMINGS),
      cachedPromptTokens: statistics(inferenceRows.map(row => nonnegative(row.vllmCachedPromptTokens))),
      note: "Totals are sums of recorded work. Nested timings and concurrent requests overlap; do not sum these into wall time or infer idle time from them.",
    },
    gpuActivity: {
      inference: distributionStatistics(inferenceRows, [
        "gpuActivitySampleCount", "gpuUtilizationMeanPercent", "gpuUtilizationMaxPercent",
        "gpuMemoryBusUtilizationMeanPercent", "gpuActivityWindowSeconds", "gpuActivityObservedSpanSeconds",
        "gpuInterRequestGapSeconds", "gpuInterRequestSampleCount", "gpuInterRequestUtilizationMeanPercent",
      ]),
      optimizer: distributionStatistics(optimizer.map(event => record(event.data.hardware)), [
        "gpuActivitySampleCount", "gpuUtilizationMeanPercent", "gpuUtilizationMaxPercent",
        "gpuMemoryBusUtilizationMeanPercent", "gpuActivityWindowSeconds", "gpuActivityObservedSpanSeconds",
      ]),
      note: "Device-wide one-second samples can include other co-resident work. Between-request activity is worker-wide, not attributed tool or idle time. Per-window statistics are not time-weighted whole-job utilization; short windows may have no samples.",
    },
    costs: {
      accountingBasis: "job_accrued_meter_not_final_provider_invoice",
      jobAccruedSpendUsd: job.accruedSpendUsd,
      executionReceiptSpendUsd: outputs.receipt?.spendUsd ?? null,
      perRecordedEligibleTrajectoryUsd: eligible.length ? job.accruedSpendUsd / eligible.length : null,
      perAppliedUpdateUsd: currentExecution.optimizerUpdatesApplied ? job.accruedSpendUsd / currentExecution.optimizerUpdatesApplied : null,
      allocationGpuUsd: statistics([...allocationById.values()].map(event => nonnegative(event.data.accruedGpuUsd))),
      allocationGpuSeconds: statistics([...allocationById.values()].map(event => nonnegative(event.data.accruedGpuSeconds))),
      physicalInvoiceTotalUsd: null,
      note: "Job, receipt and allocation amounts are overlapping accounting views, not additive charges. Physical startup/idle/storage and provider settlement are not established by this report.",
    },
    cleanup: { executionReceiptAvailable: outputs.receipt !== null, complete: cleanupComplete,
      ...(serving ? { nativeAttestationAvailable: serving.cleanupAttestation !== null,
        nativeCustody: serving.cleanupAttestation } : {}) },
    findings,
  };
}
