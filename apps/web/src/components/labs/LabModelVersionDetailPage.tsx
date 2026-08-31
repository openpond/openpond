import { useMemo, useState } from "react";
import {
  type ModelEvaluationReceipt,
  type ModelEvaluationStopReceipt,
  type ModelRun,
  type TrainingJobEvent,
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
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
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
}: ModelWorkspaceProps & {
  connection: ClientConnection | null;
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
  const currentRunStatus =
    detail.detail?.job.status ??
    selectedLifecycleRun?.status ??
    selectedJob?.status ??
    "imported";
  const runActive = ["queued", "starting", "running", "reconciling"].includes(
    currentRunStatus,
  );
  const latestActivity = detail.detail?.events.at(-1);
  const runStatus = statusLabel(currentRunStatus);
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
  const detailTabs: Array<{ id: RunDetailTab; label: string }> = [
    { id: "overview", label: "Overview" },
    ...(selectedJob ? [{ id: "metrics" as const, label: "Metrics" }] : []),
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
        status={<LabStatusBadge
          label={runActive && latestActivity
            ? `${runStatus} · ${eventSummary(latestActivity)}`
            : runStatus}
          pulse={runActive}
          tone={runActive ? "positive" : undefined}
          value={currentRunStatus}
        />}
        metrics={[
          {
            label: isGrpo ? "Rollout groups" : "Training steps",
            value: progressMetric.value,
            hint: progressMetric.hint,
          },
          ...(isGrpo && rolloutProgress
            ? [
                {
                  label: "Updates applied",
                  value: rolloutProgress.optimizerUpdatesApplied.toLocaleString(),
                  hint: "optimizer transitions",
                },
                {
                  label: "Updates skipped",
                  value: rolloutProgress.optimizerUpdatesSkipped.toLocaleString(),
                  hint: "zero-signal groups",
                },
              ]
            : []),
          { label: "Final reward", value: formatMetric(selectedLifecycleRun?.reward?.raw ?? managedEvidence?.reward.finalMean ?? null) },
          { label: "Duration", value: selectedLifecycleRun ? formatDuration(selectedLifecycleRun.startedAt, terminalRunEnd(selectedLifecycleRun.status, selectedLifecycleRun.completedAt, selectedLifecycleRun.updatedAt)) : selectedJob ? formatDuration(selectedJob.startedAt, terminalRunEnd(selectedJob.status, selectedJob.completedAt, selectedJob.updatedAt)) : "Not recorded" },
          { label: "Output", value: selectedVersion ? `Version ${selectedVersion.number}` : "No version" },
          { label: "Taskset", value: selectedTaskset?.name ?? "Unavailable" },
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
          {activeDetailTab === "overview" ? <LabModelRunSummary
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
        configuration={runConfiguration(selectedPlan)}
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

function scientificNumber(value: number): string {
  return value === 0 ? "0" : value.toExponential(2);
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
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

function TrainingEventLog({
  error,
  events,
  loading,
}: {
  error: string | null;
  events: TrainingJobEvent[];
  loading: boolean;
}) {
  if (loading && !events.length) {
    return <div className="training-run-placeholder">Loading run events…</div>;
  }
  if (!events.length) {
    return (
      <div className="training-run-placeholder">
        {error ?? "No normalized run events were recorded."}
      </div>
    );
  }
  return (
    <div
      aria-label="Training activity log"
      aria-live="polite"
      className="training-event-log"
      role="log"
    >
      {events.map((event) => (
        <div className={`training-event-log-line ${event.type}`} key={event.id}>
          <time dateTime={event.timestamp}>{formatDateTime(event.timestamp)}</time>
          <span>{eventLabel(event.type)}</span>
          <code>{eventSummary(event)}</code>
        </div>
      ))}
      {error ? (
        <div className="training-event-log-line failure">
          <time>—</time>
          <span>Failure</span>
          <code>{error}</code>
        </div>
      ) : null}
    </div>
  );
}

function eventLabel(type: TrainingJobEvent["type"]): string {
  return type
    .replaceAll("_", " ")
    .replace(/^./, (value) => value.toUpperCase());
}

export function eventSummary(event: TrainingJobEvent): string {
  const payload = event.payload;
  const step = finiteNumber(payload.step);
  const maxSteps = finiteNumber(payload.maxSteps);
  if (typeof payload.telemetryType === "string") {
    const message =
      typeof payload.message === "string" ? payload.message : null;
    const errorCode =
      typeof payload.errorCode === "string" ? payload.errorCode : null;
    const source =
      typeof payload.telemetrySource === "string"
        ? ` · ${payload.telemetrySource}`
        : "";
    return `${message ?? payload.telemetryType.replaceAll("_", " ")}${
      step == null ? "" : ` · step ${step}`
    }${source}${errorCode ? ` · ${errorCode}` : ""}`;
  }
  if (typeof payload.remoteEventType === "string") {
    const label = remoteEventLabel(payload.remoteEventType);
    const phase =
      typeof payload.remotePhase === "string"
        ? remotePhaseLabel(payload.remotePhase)
        : null;
    const errorCode =
      typeof payload.errorCode === "string" && payload.errorCode.trim()
        ? payload.errorCode.trim()
        : null;
    return [
      label,
      phase,
      step == null ? null : `step ${step}`,
      errorCode ? `error ${errorCode}` : null,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (event.type === "start") {
    return typeof payload.device === "string"
      ? `Worker started on ${payload.device}.`
      : "Worker started.";
  }
  if (event.type === "progress" && step != null) {
    return maxSteps == null ? `Step ${step}.` : `Step ${step} of ${maxSteps}.`;
  }
  if (event.type === "metric") {
    const kind =
      typeof payload.metricKind === "string"
        ? payload.metricKind.replaceAll("_", " ")
        : "metric";
    const values = [
      numericSummary("loss", payload.loss),
      numericSummary("reward", payload.meanReward ?? payload.reward),
      numericSummary("policy loss", payload.policyLoss),
      numericSummary("value loss", payload.valueLoss),
      numericSummary(
        "preference accuracy",
        payload.preferenceAccuracy,
        percentValue
      ),
    ].filter((value): value is string => Boolean(value));
    const failureClass =
      typeof payload.failureClass === "string" ? payload.failureClass : null;
    const failureCode =
      typeof payload.failureCode === "string" ? payload.failureCode : null;
    const managedMetric =
      typeof payload.metricId === "string" &&
      typeof payload.value === "number"
        ? ` · ${payload.metricId}: ${payload.value.toPrecision(4)}`
        : "";
    return `${kind}${step == null ? "" : ` · step ${step}`}${managedMetric}${
      failureClass ? ` · ${failureClass}` : ""
    }${failureCode ? ` · ${failureCode}` : ""}${
      values.length ? ` · ${values.join(" · ")}` : ""
    }`;
  }
  if (event.type === "checkpoint") {
    const policyVersion = finiteNumber(payload.policyVersion);
    const sizeBytes = finiteNumber(payload.sizeBytes);
    const details = [
      policyVersion == null ? null : `policy ${policyVersion}`,
      sizeBytes == null ? null : formatBytes(sizeBytes),
      payload.final === true ? "final" : null,
    ].filter((value): value is string => Boolean(value));
    return details.length
      ? `Checkpoint committed · ${details.join(" · ")}.`
      : "Checkpoint committed.";
  }
  if (event.type === "complete") {
    const artifactCount = finiteNumber(payload.artifactCount);
    return artifactCount == null
      ? "Worker completed."
      : `Worker completed with ${artifactCount} artifacts.`;
  }
  if (event.type === "failure" && typeof payload.message === "string") {
    return payload.message;
  }
  return Object.keys(payload).length ? JSON.stringify(payload) : "Recorded.";
}

function remoteEventLabel(value: string): string {
  const known: Record<string, string> = {
    drain: "Rollout drain",
    infer: "Model inference",
    materialize_checkpoint: "Checkpoint materialization",
    optimizer_metric: "Optimizer metric",
    provision_gpu: "GPU provisioning",
    rollout_metric: "Rollout trajectory",
    score_reward_model: "Reward scoring",
    start_inference: "Policy server",
    train_step: "Optimizer update",
    upload_checkpoint: "Checkpoint upload",
  };
  return known[value] ?? humanizeEventValue(value);
}

function remotePhaseLabel(value: string): string {
  const known: Record<string, string> = {
    committed: "committed",
    completed: "completed",
    eligible: "recorded",
    failed: "failed",
    running: "running",
    succeeded: "succeeded",
  };
  return known[value] ?? humanizeEventValue(value).toLocaleLowerCase();
}

function humanizeEventValue(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function numericSummary(
  label: string,
  value: unknown,
  format: (value: number) => string = (number) =>
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(
      number
    )
): string | null {
  const number = finiteNumber(value);
  return number == null ? null : `${label} ${format(number)}`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentValue(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
