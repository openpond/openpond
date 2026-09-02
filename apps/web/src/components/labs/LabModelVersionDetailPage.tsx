import { useMemo, useState } from "react";
import {
  type ModelEvaluationReceipt,
  type ModelEvaluationStopReceipt,
  type ModelComparisonSeriesEntry,
  type ModelRun,
  type TrainingStateResponse,
} from "@openpond/contracts";

import type { ClientConnection } from "../../api";
import {
  TrainingManagedAttempts,
  TrainingRolloutReceipts,
} from "../training/TrainingModelEvidence";
import { TrainingRunEvaluation } from "../training/TrainingRunEvaluation";
import { TrainingRunMetrics } from "../training/TrainingRunMetrics";
import {
  destinationLabel,
  formatDateTime,
  formatDuration,
  statusLabel,
  terminalRunEnd,
  trainingMethodLabel,
} from "../training/training-model-data";
import { useTrainingRunDetail } from "../training/useTrainingRunDetail";
import { LabModelRunSummary } from "./LabModelRunSummary";
import { EvaluationComparisonCharts } from "./EvaluationComparisonCharts";
import {
  benchmarkForegroundUsage,
  benchmarkTaskEfficiency,
} from "./benchmark-attempt-usage";
import {
  BenchmarkAttemptCharts,
  BenchmarkAttemptTable,
  BenchmarkComparisonSummary,
  BenchmarkProgress,
  StoppedEvaluationDetail,
} from "./LabModelEvaluationBenchmarkDetails";
import { LabStatusBadge } from "./LabStatusBadge";
import {
  isActiveRunStatus,
  LabRunStatusBadge,
  resolveRunStatus,
} from "./LabRunStatusBadge";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
import {
  eventSummary,
  formatBytes,
  TrainingEventLog,
} from "./LabModelTrainingActivity";
import {
  labLifecycleModelRuns,
  labModelJobs,
  labModelPlans,
  labModelTasksets,
  labModelVersions,
} from "./lab-models";
import {
  modelRunEntries,
  modelVersionEntries,
  type ModelWorkspaceProps,
} from "./LabModelWorkspace";

type RunDetailTab =
  | "overview"
  | "details"
  | "metrics"
  | "artifacts"
  | "evaluation"
  | "rollouts"
  | "activity";

type ManagedRolloutProgress = {
  groupsCompleted: number;
  groupsTarget: number;
  optimizerUpdatesApplied: number;
  optimizerUpdatesSkipped: number;
};

export function LabModelVersionDetailPage({
  connection,
  detailTab,
  onDetailTabChange,
  selectedEntryKey,
  workproduct,
  runs,
  training,
  onOpenDataset,
  onOpenConversation,
  detailKind,
}: ModelWorkspaceProps & {
  connection: ClientConnection | null;
  detailKind: "run" | "version";
  detailTab: string | null;
  onDetailTabChange: (tab: string) => void;
  selectedEntryKey: string;
  onOpenConversation: (conversationId: string) => void;
}) {
  const state = training.payload;
  const jobs = useMemo(
    () => labModelJobs(workproduct, runs, state),
    [runs, state, workproduct]
  );
  const versions = useMemo(
    () => labModelVersions(workproduct, runs, state),
    [runs, state, workproduct]
  );
  const lifecycleRuns = useMemo(
    () => labLifecycleModelRuns(workproduct, state),
    [state, workproduct]
  );
  const plans = useMemo(
    () => labModelPlans(workproduct, runs, state),
    [runs, state, workproduct]
  );
  const planById = useMemo(
    () => new Map(plans.map((plan) => [plan.id, plan] as const)),
    [plans]
  );
  const entries = useMemo(
    () => modelVersionEntries(jobs, versions),
    [jobs, versions]
  );
  const selectedEntry =
    entries.find((entry) => entry.key === selectedEntryKey) ?? null;
  const selectedLifecycleRunId = selectedEntryKey.startsWith("model-run:")
    ? selectedEntryKey.slice("model-run:".length)
    : null;
  const selectedLifecycleRun = selectedLifecycleRunId
    ? lifecycleRuns.find((run) => run.id === selectedLifecycleRunId) ?? null
    : selectedEntry?.job
    ? lifecycleRuns.find(
        (run) => run.id === selectedEntry.job?.metadata.modelRunId
      ) ?? null
    : null;
  const selectedJob =
    selectedEntry?.job ??
    (selectedLifecycleRun
      ? state?.jobs.find(
          (job) =>
            job.id === selectedLifecycleRun.id ||
            job.metadata.modelRunId === selectedLifecycleRun.id
        ) ?? null
      : null);
  const selectedComparisonEntry = state?.comparisonSeriesEntries.find(
    (entry) =>
      entry.modelRunId === selectedLifecycleRun?.id ||
      entry.modelRunId === selectedJob?.metadata.modelRunId,
  ) ?? null;
  const selectedBasedOn = comparisonParentLabel(state, selectedComparisonEntry);
  const runEntries = useMemo(
    () => modelRunEntries(jobs, versions, lifecycleRuns),
    [jobs, lifecycleRuns, versions]
  );
  const selectedRunIndex = runEntries.findIndex(
    (entry) =>
      entry.key === selectedEntryKey ||
      (selectedJob !== null && entry.job?.id === selectedJob.id) ||
      (selectedLifecycleRun !== null &&
        entry.lifecycleRun?.id === selectedLifecycleRun.id)
  );
  const selectedRunNumber =
    selectedRunIndex < 0 ? null : runEntries.length - selectedRunIndex;
  const selectedVersion =
    selectedEntry?.version ??
    (selectedLifecycleRun?.adapterArtifactLineageId
      ? versions.find(
          (version) =>
            version.lineage.id === selectedLifecycleRun.adapterArtifactLineageId
        ) ?? null
      : null);
  const selectedBaseModelId =
    (selectedLifecycleRun
      ? state?.modelVersions.find(
          (version) => version.id === selectedLifecycleRun.modelVersionId
        )?.baseModel.modelId
      : null) ??
    state?.modelVersions
      .filter(
        (version) =>
          version.modelId === workproduct.id &&
          version.kind === "base_reference"
      )
      .sort((left, right) => right.version - left.version)[0]?.baseModel
      .modelId ??
    null;
  const selectedEvaluationArtifactId =
    selectedVersion?.lineage.frozenEvaluationArtifactId ?? null;
  const selectedPlan =
    selectedVersion?.plan ??
    (selectedJob ? planById.get(selectedJob.planId) ?? null : null);
  const selectedTaskset =
    selectedVersion?.taskset ??
    labModelTasksets(state).find(
      (taskset) =>
        taskset.id ===
        (selectedLifecycleRun?.taskset.id ?? selectedPlan?.tasksetId)
    ) ??
    null;
  const detail = useTrainingRunDetail(
    connection,
    selectedJob?.id ?? null,
    selectedJob?.status ?? null
  );
  const receipts = selectedJob
    ? state?.rolloutReceipts.filter(
        (receipt) => receipt.jobId === selectedJob.id
      ) ?? []
    : [];
  const managedEvidence = detail.detail?.managedEvidence ?? null;
  const hasManagedAttempts = detail.detail?.events.some(
    (event) =>
      event.type === "metric" &&
      event.payload.metricKind === "rollout_trajectory",
  ) ?? false;
  const currentRunStatus = resolveRunStatus({
    lifecycleRun: selectedLifecycleRun,
    job: detail.detail?.job ?? selectedJob,
  });
  const runActive = isActiveRunStatus(currentRunStatus);
  const isGrpo = selectedPlan?.recipe.method === "grpo";
  const rolloutProgress = managedRolloutProgress(selectedJob?.metadata);
  const optimizerStepsTarget =
    (selectedPlan &&
    (selectedPlan.recipe.method === "sft" ||
      selectedPlan.recipe.method === "dpo" ||
      selectedPlan.recipe.method === "grpo")
      ? selectedPlan.recipe.optimizer.maxSteps
      : null) ??
    managedEvidence?.progress.targetOptimizerSteps ??
    null;
  const locallyReconciledSteps =
    optimizerStepsTarget !== null &&
    typeof selectedJob?.metadata.progress === "number" &&
    Number.isFinite(selectedJob.metadata.progress)
      ? Math.floor(
          Math.max(0, selectedJob.metadata.progress) * optimizerStepsTarget,
        )
      : 0;
  const optimizerStepsObserved = Math.max(
    0,
    rolloutProgress?.optimizerUpdatesApplied ?? 0,
    locallyReconciledSteps,
    detail.detail?.policyMetrics.reduce(
      (maximum, metric) => Math.max(maximum, metric.step),
      0,
    ) ?? 0,
    detail.detail?.stepMetrics.reduce(
      (maximum, metric) => Math.max(maximum, metric.step),
      0,
    ) ?? 0,
    managedEvidence?.progress.committedOptimizerSteps ?? 0,
  );
  const progressMetric = formatTrainingProgress(
    isGrpo && rolloutProgress
      ? rolloutProgress.groupsCompleted
      : optimizerStepsObserved,
    isGrpo && rolloutProgress
      ? rolloutProgress.groupsTarget
      : optimizerStepsTarget,
  );
  const summaryTab: { id: RunDetailTab; label: string } = detailKind === "run"
    ? { id: "details", label: "Details" }
    : { id: "overview", label: "Overview" };
  const detailTabs: Array<{ id: RunDetailTab; label: string }> = [
    ...(detailKind === "run" && selectedJob
      ? [{ id: "metrics" as const, label: "Metrics" }]
      : []),
    summaryTab,
    ...(detailKind === "version" && selectedJob
      ? [{ id: "metrics" as const, label: "Metrics" }]
      : []),
    { id: "evaluation", label: "Evaluation" },
    ...(receipts.length || hasManagedAttempts
      ? [{ id: "rollouts" as const, label: "Rollouts" }]
      : []),
    { id: "artifacts", label: "Artifacts" },
    ...(selectedJob
      ? [{ id: "activity" as const, label: "Activity" }]
      : []),
  ];
  const requestedDetailTab = detailTab as RunDetailTab | null;
  const activeDetailTab = detailTabs.some(
    (tab) => tab.id === requestedDetailTab,
  )
    ? requestedDetailTab!
    : detailTabs[0]!.id;
  if (!selectedEntry && !selectedLifecycleRun) {
    return (
      <div className="labs-model-version-detail">
        <div className="training-run-placeholder">
          This training attempt is no longer available.
        </div>
      </div>
    );
  }
  if (selectedLifecycleRun?.kind === "evaluation") {
    return (
      <LabModelEvaluationRunDetail
        run={selectedLifecycleRun}
        runNumber={selectedRunNumber}
        tasksetName={selectedTaskset?.name ?? "Unavailable"}
        onOpenTaskset={
          selectedTaskset
            ? () => onOpenDataset(selectedTaskset.id)
            : undefined
        }
        onOpenConversation={onOpenConversation}
      />
    );
  }

  return (
    <div className="labs-model-version-detail">
      <ModelProjectPageHeader
        title={selectedLifecycleRun || selectedJob
          ? selectedRunNumber ? `Run ${selectedRunNumber}` : "Run details"
          : selectedVersion ? `Version ${selectedVersion.number}` : "Run details"}
        description={`${trainingMethodLabel(selectedLifecycleRun?.method ?? selectedPlan?.recipe.method)} on ${baseModelName(selectedPlan, selectedBaseModelId)}`}
        status={<LabRunStatusBadge status={currentRunStatus} />}
        metrics={[
          {
            label: isGrpo ? "Rollout groups" : "Training steps",
            value: progressMetric.value,
          },
          { label: "Final reward", value: formatMetric(selectedLifecycleRun?.reward?.raw ?? managedEvidence?.reward.finalMean ?? null) },
          { label: "Duration", value: selectedLifecycleRun ? formatDuration(selectedLifecycleRun.startedAt, terminalRunEnd(selectedLifecycleRun.status, selectedLifecycleRun.completedAt, selectedLifecycleRun.updatedAt)) : selectedJob ? formatDuration(selectedJob.startedAt, terminalRunEnd(selectedJob.status, selectedJob.completedAt, selectedJob.updatedAt)) : "Not recorded" },
          { label: "Output", value: selectedVersion ? `Version ${selectedVersion.number}` : "No version" },
          { label: "Based on", value: selectedBasedOn },
          {
            label: "Taskset",
            value: selectedTaskset?.name ?? "Unavailable",
            onSelect: selectedTaskset
              ? () => onOpenDataset(selectedTaskset.id)
              : undefined,
            ariaLabel: selectedTaskset
              ? `Open Taskset ${selectedTaskset.name}`
              : undefined,
          },
        ]}
      />

      <section className="labs-run-detail-tabs">
        <div
          className="training-detail-tabs"
          role="tablist"
          aria-label="Run details"
        >
          {detailTabs.map((tab) => (
            <button
              aria-controls={`run-detail-panel-${tab.id}`}
              aria-selected={activeDetailTab === tab.id}
              className={activeDetailTab === tab.id ? "active" : undefined}
              id={`run-detail-tab-${tab.id}`}
              key={tab.id}
              role="tab"
              type="button"
              onClick={() => onDetailTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div
          aria-labelledby={`run-detail-tab-${activeDetailTab}`}
          className="labs-run-detail-tab-panel"
          id={`run-detail-panel-${activeDetailTab}`}
          role="tabpanel"
        >
          {activeDetailTab === summaryTab.id ? <LabModelRunSummary
        baseModel={baseModelName(selectedPlan, selectedBaseModelId)}
        compute={
          selectedLifecycleRun
            ? destinationLabel(selectedLifecycleRun.destinationId ?? "")
            : selectedPlan
            ? destinationLabel(selectedPlan.destinationId)
            : selectedJob
            ? destinationLabel(selectedJob.destinationId)
            : "Not recorded"
        }
        duration={
          selectedLifecycleRun
            ? formatDuration(
                selectedLifecycleRun.startedAt,
                terminalRunEnd(
                  selectedLifecycleRun.status,
                  selectedLifecycleRun.completedAt,
                  selectedLifecycleRun.updatedAt
                )
              )
            : selectedJob
            ? formatDuration(
                selectedJob.startedAt,
                terminalRunEnd(
                  selectedJob.status,
                  selectedJob.completedAt,
                  selectedJob.updatedAt
                )
              )
            : "Not recorded"
        }
        failure={selectedJob?.error ?? selectedLifecycleRun?.failure ?? null}
        configuration={[
          ...continuationConfiguration(state, selectedComparisonEntry),
          ...runConfiguration(selectedPlan),
        ]}
        evidence={managedEvidence}
        method={trainingMethodLabel(
          selectedLifecycleRun?.method ?? selectedPlan?.recipe.method
        )}
        output={
          selectedVersion
            ? `Version ${selectedVersion.number}`
            : "No version created"
        }
        reward={
          selectedLifecycleRun?.reward?.raw ??
          managedEvidence?.reward.finalMean ??
          null
        }
        status={
          selectedLifecycleRun
            ? statusLabel(selectedLifecycleRun.status)
            : selectedJob
            ? statusLabel(selectedJob.status)
            : "Imported"
        }
        statusValue={
          selectedLifecycleRun?.status ?? selectedJob?.status ?? "imported"
        }
        taskset={selectedTaskset?.name ?? "Unavailable"}
        telemetry={
          selectedLifecycleRun?.receipt?.schemaVersion
            === "openpond.modelRunReceipt.v1"
            ? selectedLifecycleRun.receipt.telemetry
            : null
        }
        title={
          selectedLifecycleRun || selectedJob
            ? selectedRunNumber
              ? `Run ${selectedRunNumber}`
              : "Run details"
            : selectedVersion
            ? `Version ${selectedVersion.number}`
            : "Run details"
        }
        versionStatus={
          selectedVersion
            ? selectedVersion.current
              ? "Active"
              : "Available"
            : null
        }
        onOpenTaskset={
          selectedTaskset
            ? () => onOpenDataset(selectedTaskset.id)
            : undefined
        }
        showHeader={false}
      /> : null}
          {activeDetailTab === "metrics" && selectedJob ? (
          <TrainingRunMetrics
            detail={detail.detail}
            error={detail.error}
            loading={detail.loading}
          />
        ) : null}
          {activeDetailTab === "artifacts" ? (
            <dl className="training-configuration-list">
              <Fact
                label="Training attempt"
                value={selectedJob?.id ?? "Provider import"}
              />
              <Fact
                label="Taskset"
                value={selectedTaskset?.name ?? "Unavailable"}
              />
              <Fact
                label="Prepared data"
                value={selectedJob?.bundleHash ?? "Provider managed"}
              />
              <Fact
                label="Version ID"
                value={
                  selectedVersion?.lineage.id ?? "No version created"
                }
              />
              {managedEvidence?.checkpoint ? (
                <>
                  <Fact
                    label="Checkpoint"
                    value={managedEvidence.checkpoint.id}
                  />
                  <Fact
                    label="Checkpoint size"
                    value={
                      managedEvidence.checkpoint.sizeBytes == null
                        ? "Not reported"
                        : formatBytes(managedEvidence.checkpoint.sizeBytes)
                    }
                  />
                  <Fact
                    label="Checkpoint hash"
                    value={
                      managedEvidence.checkpoint.sha256 ?? "Not reported"
                    }
                  />
                </>
              ) : null}
              {managedEvidence?.canonicalPublication.state ? (
                <Fact
                  label="Registry publication"
                  value={managedStateLabel(
                    managedEvidence.canonicalPublication.state
                  )}
                />
              ) : null}
            </dl>
          ) : null}
          {activeDetailTab === "evaluation" ? (
            <div className="training-run-evaluation">
              <TrainingRunEvaluation
                detail={detail.detail}
                loading={detail.loading}
                pending={runActive}
              />
              {!detail.detail?.evaluation &&
              managedEvidence?.evaluations.length ? (
                <dl className="labs-inline-facts">
                  {managedEvidence.evaluations.map((evaluation) => (
                    <Fact
                      key={`${evaluation.kind}:${evaluation.policyVersion}`}
                      label={
                        evaluation.kind === "baseline"
                          ? "Baseline score"
                          : "Candidate score"
                      }
                      value={
                        evaluation.score == null
                          ? "Not reported"
                          : evaluation.score.toFixed(6)
                      }
                    />
                  ))}
                </dl>
              ) : null}
              {selectedEvaluationArtifactId ? (
                <button
                  className="training-button secondary"
                  type="button"
                  onClick={() =>
                    void training.actions.downloadArtifact(
                      selectedEvaluationArtifactId
                    )
                  }
                >
                  Download evaluation receipt
                </button>
              ) : null}
            </div>
          ) : null}
          {activeDetailTab === "rollouts" ? (
            receipts.length ? (
              <TrainingRolloutReceipts receipts={receipts} />
            ) : (
              <TrainingManagedAttempts events={detail.detail?.events ?? []} />
            )
          ) : null}
          {activeDetailTab === "activity" && selectedJob ? (
            <TrainingEventLog
              error={selectedJob.error ?? detail.error}
              events={detail.detail?.events ?? []}
              loading={detail.loading}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}

export function formatTrainingProgress(
  observed: number,
  target: number | null,
): { value: string; hint: string } {
  const completed = Math.max(0, Math.floor(observed));
  if (target === null || !Number.isFinite(target) || target <= 0) {
    return {
      value: completed.toLocaleString(),
      hint: completed === 1 ? "completed update" : "completed updates",
    };
  }
  const planned = Math.max(1, Math.floor(target));
  return {
    value: `${completed.toLocaleString()} / ${planned.toLocaleString()}`,
    hint: "completed / planned",
  };
}

export function managedRolloutProgress(
  metadata: Record<string, unknown> | null | undefined,
): ManagedRolloutProgress | null {
  const value = metadata?.rolloutProgress;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const progress = value as Record<string, unknown>;
  const fields = [
    "groupsCompleted",
    "groupsTarget",
    "optimizerUpdatesApplied",
    "optimizerUpdatesSkipped",
  ] as const;
  if (
    fields.some(
      (field) =>
        typeof progress[field] !== "number" ||
        !Number.isInteger(progress[field]) ||
        (progress[field] as number) < 0,
    )
  ) {
    return null;
  }
  return {
    groupsCompleted: progress.groupsCompleted as number,
    groupsTarget: progress.groupsTarget as number,
    optimizerUpdatesApplied: progress.optimizerUpdatesApplied as number,
    optimizerUpdatesSkipped: progress.optimizerUpdatesSkipped as number,
  };
}

function LabModelEvaluationRunDetail({
  run,
  runNumber,
  tasksetName,
  onOpenTaskset,
  onOpenConversation,
}: {
  run: ModelRun;
  runNumber: number | null;
  tasksetName: string;
  onOpenTaskset?: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<"results" | "scenarios" | "activity">("results");
  const receipt = run.receipt?.schemaVersion === "openpond.modelEvaluationReceipt.v1"
    ? run.receipt as ModelEvaluationReceipt
    : null;
  const stopReceipt = run.receipt?.schemaVersion === "openpond.modelEvaluationStopReceipt.v1"
    ? run.receipt as ModelEvaluationStopReceipt
    : null;
  const foregroundUsage = receipt ? benchmarkForegroundUsage(receipt) : null;
  const taskEfficiency = receipt ? benchmarkTaskEfficiency(receipt) : null;
  return (
    <div className="labs-model-version-detail labs-model-evaluation-detail">
      <ModelProjectPageHeader
        title={runNumber ? `Eval ${runNumber}` : "Evaluation run"}
        description={`Harness Refiner benchmark · ${tasksetName}`}
        status={<LabStatusBadge
                label={receipt
                  ? taskEfficiency?.comparedTaskCount
                    ? `${taskEfficiency.passedTaskCount}/${taskEfficiency.comparedTaskCount} passed`
                    : "No paired result"
                  : stopReceipt
                    ? "Inconclusive"
                    : statusLabel(run.status)}
                value={receipt
                  ? taskEfficiency?.comparedTaskCount
                    && taskEfficiency.passed
                    ? "succeeded"
                    : "neutral"
                  : stopReceipt?.terminalClassification ?? run.status}
              />}
        metrics={[
          { label: "Baseline pass rate", value: receipt ? `${(receipt.quality.baselinePassRate * 100).toFixed(1)}%` : "—" },
          { label: "Candidate pass rate", value: receipt ? `${(receipt.quality.candidatePassRate * 100).toFixed(1)}%` : "—" },
          { label: "Scenarios", value: receipt?.attempts?.length ?? 0 },
          { label: "Execution", value: statusLabel(run.status) },
        ]}
      />
      <div className="training-detail-tabs" role="tablist" aria-label="Evaluation details">
        {(["results", "scenarios", "activity"] as const).map((tab) => (
          <button key={tab} className={activeTab === tab ? "active" : undefined} aria-selected={activeTab === tab} role="tab" type="button" onClick={() => setActiveTab(tab)}>
            {tab === "results" ? "Results" : tab === "scenarios" ? "Scenarios" : "Activity"}
          </button>
        ))}
      </div>

      {activeTab === "results" && receipt ? (
        <>
          <EvaluationComparisonCharts
            series={[
              {
                id: "baseline",
                label: "Held-out baseline",
                inputTokens: foregroundUsage!.baseline.inputTokens,
                outputTokens: foregroundUsage!.baseline.outputTokens,
                tokens: foregroundUsage!.baseline.totalTokens,
                passRate: receipt.quality.baselinePassRate,
                costUsd: foregroundUsage!.baseline.costUsd,
              },
              {
                id: "candidate",
                label: "Held-out refined",
                inputTokens: foregroundUsage!.candidate.inputTokens,
                outputTokens: foregroundUsage!.candidate.outputTokens,
                tokens: foregroundUsage!.candidate.totalTokens,
                passRate: receipt.quality.candidatePassRate,
                costUsd: foregroundUsage!.candidate.costUsd,
              },
            ]}
          />
          <EvaluationComparisonCharts
            series={[
              {
                id: "adaptation-baseline",
                label: "Adaptation baseline",
                inputTokens: foregroundUsage!.adaptation.inputTokens,
                outputTokens: foregroundUsage!.adaptation.outputTokens,
                tokens: foregroundUsage!.adaptation.totalTokens,
                passRate: receipt.quality.adaptationBaselinePassRate,
                costUsd: foregroundUsage!.adaptation.costUsd,
              },
              {
                id: "adaptation-candidate",
                label: "Adaptation replay",
                inputTokens: foregroundUsage!.candidate_adaptation.inputTokens,
                outputTokens: foregroundUsage!.candidate_adaptation.outputTokens,
                tokens: foregroundUsage!.candidate_adaptation.totalTokens,
                passRate: receipt.quality.adaptationCandidatePassRate,
                costUsd: foregroundUsage!.candidate_adaptation.costUsd,
              },
            ]}
          />
          <BenchmarkComparisonSummary
            receipt={receipt}
            run={run}
            tasksetName={tasksetName}
            onOpenTaskset={onOpenTaskset}
          />
        </>
      ) : activeTab === "results" && stopReceipt ? (
        <StoppedEvaluationDetail
          receipt={stopReceipt}
          onOpenConversation={onOpenConversation}
        />
      ) : activeTab === "results" ? (
        <section className="labs-run-summary-card">
          {run.failure ? (
            <p className="training-run-placeholder">{run.failure}</p>
          ) : (
            <BenchmarkProgress run={run} />
          )}
        </section>
      ) : null}
      {activeTab === "scenarios" && receipt ? (
        <>
          {(receipt.attempts ?? []).length ? <BenchmarkAttemptCharts receipt={receipt} /> : null}
          {(receipt.attempts ?? []).length ? <BenchmarkAttemptTable receipt={receipt} onOpenConversation={onOpenConversation} /> : <div className="training-run-placeholder">No per-scenario attempts were retained.</div>}
        </>
      ) : null}
      {activeTab === "activity" ? (
        <dl className="labs-inline-facts">
          <Fact label="Run ID" value={run.id} />
          <Fact label="Status" value={statusLabel(run.status)} />
          <Fact label="Started" value={run.startedAt ? formatDateTime(run.startedAt) : "Not started"} />
          <Fact label="Completed" value={run.completedAt ? formatDateTime(run.completedAt) : "In progress"} />
        </dl>
      ) : null}
    </div>
  );
}

function baseModelName(
  plan: ReturnType<typeof labModelPlans>[number] | null,
  fallback: string | null = null
) {
  if (!plan) return fallback ? modelRefName(fallback) : "Not recorded";
  const model =
    plan.recipe.method === "sft" || plan.recipe.method === "grpo"
      ? plan.recipe.baseModel
      : plan.recipe.method === "dpo"
      ? plan.recipe.policyModel
      : plan.recipe.method === "ppo"
      ? plan.recipe.policyOptimization.policyModel
      : null;
  return model ? modelRefName(model.id) : "Not recorded";
}

function modelRefName(modelId: string) {
  return modelId.split("/").at(-1) ?? modelId;
}

function formatMetric(value: number | null): string {
  return value === null ? "Not reported" : value.toFixed(4);
}

function runConfiguration(
  plan: ReturnType<typeof labModelPlans>[number] | null,
): Array<{ label: string; value: string }> {
  if (!plan) return [];
  const recipe = plan.recipe;
  if (recipe.method === "grpo") {
    return [
      { label: "LoRA rank", value: String(recipe.lora.rank) },
      {
        label: "Learning rate",
        value: scientificNumber(recipe.optimizer.learningRate),
      },
      { label: "Optimizer steps", value: String(recipe.optimizer.maxSteps) },
      { label: "Rollouts per update", value: String(recipe.rollout.groupSize) },
      { label: "Rollout concurrency", value: String(recipe.rollout.concurrency) },
      {
        label: "Max output tokens",
        value: recipe.rollout.maxOutputTokens.toLocaleString(),
      },
      { label: "Temperature", value: String(recipe.rollout.temperature) },
      { label: "Top P", value: String(recipe.rollout.topP) },
    ];
  }
  if (recipe.method === "sft" || recipe.method === "dpo") {
    return [
      { label: "LoRA rank", value: String(recipe.lora.rank) },
      {
        label: "Learning rate",
        value: scientificNumber(recipe.optimizer.learningRate),
      },
      { label: "Optimizer steps", value: String(recipe.optimizer.maxSteps) },
    ];
  }
  return [];
}

function continuationConfiguration(
  state: TrainingStateResponse | null,
  entry: ModelComparisonSeriesEntry | null,
): Array<{ label: string; value: string }> {
  if (!state || !entry) return [];
  if (entry.parent.kind === "base_model") {
    return [
      {
        label: "Starting checkpoint",
        value: `Frozen base · ${entry.parent.revision}`,
      },
      { label: "Optimizer", value: "Fresh" },
    ];
  }
  const parentVersion = state.modelVersions.find(
    (version) => version.id === entry.parent.id,
  );
  const parentEntry = state.comparisonSeriesEntries.find(
    (candidate) =>
      candidate.seriesId === entry.seriesId &&
      candidate.modelVersionId === entry.parent.id,
  );
  const checkpoint = [
    parentEntry?.label ?? null,
    parentVersion ? `Version ${parentVersion.version}` : entry.parent.id,
  ].filter((value): value is string => Boolean(value)).join(" · ");
  return [
    { label: "Starting checkpoint", value: checkpoint },
    { label: "Optimizer", value: "Fresh" },
  ];
}

function comparisonParentLabel(
  state: TrainingStateResponse | null,
  entry: ModelComparisonSeriesEntry | null,
): string {
  if (!state || !entry || entry.parent.kind === "base_model") return "Frozen base";
  const parentEntry = state.comparisonSeriesEntries.find(
    (candidate) =>
      candidate.seriesId === entry.seriesId
      && candidate.modelVersionId === entry.parent.id,
  );
  const parentVersion = state.modelVersions.find(
    (version) => version.id === entry.parent.id,
  );
  return [
    parentEntry?.label ?? "Prior checkpoint",
    parentVersion ? `Version ${parentVersion.version}` : null,
  ].filter((value): value is string => Boolean(value)).join(" · ");
}

function scientificNumber(value: number): string {
  return value === 0 ? "0" : value.toExponential(2);
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function managedStateLabel(value: string | null): string {
  return value
    ? value
        .replaceAll("_", " ")
        .replace(/^./, (character) => character.toUpperCase())
    : "Pending";
}

export { eventSummary };
