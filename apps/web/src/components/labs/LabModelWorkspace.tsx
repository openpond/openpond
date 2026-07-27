import { useEffect, useMemo, useState } from "react";
import type {
  CreateImproveRun,
  ModelRunDraft,
  TasksetBaselineRun,
  TrainingJob,
  TrainingJobEvent,
} from "@openpond/contracts";
import {
  managedAdapterEvaluationPassed,
  resolveModelBindingPromotionGate,
} from "@openpond/contracts";

import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import { Download, MessageSquare, Pin } from "../icons";
import { DetailSection } from "../training/DetailSection";
import { TrainingRolloutReceipts } from "../training/TrainingModelEvidence";
import { TrainingRunEvaluation } from "../training/TrainingRunEvaluation";
import { TrainingRunMetrics } from "../training/TrainingRunMetrics";
import {
  destinationLabel,
  formatDateTime,
  formatDuration,
  statusLabel,
  trainingMethodLabel,
} from "../training/training-model-data";
import { useTrainingRunDetail } from "../training/useTrainingRunDetail";
import { LabStatusBadge } from "./LabStatusBadge";
import {
  ManagedAdapterEvaluationPanel,
  ManagedAdapterServingEvidence,
} from "./ManagedAdapterServingEvidence";
import {
  currentModelBinding,
  labBaseModelVersion,
  labLifecycleModelRuns,
  labModelBaselineRuns,
  labModelJobs,
  labModelPlans,
  labModelTasksets,
  labModelVersions,
} from "./lab-models";
import type { LabWorkproductSummary } from "./lab-workproducts";

type TrainingController = ReturnType<typeof useTraining>;
type LabModelVersion = ReturnType<typeof labModelVersions>[number];
type VersionEntry = {
  key: string;
  job: TrainingJob | null;
  version: LabModelVersion | null;
  baselineRun: TasksetBaselineRun | null;
  draft: ModelRunDraft | null;
};

type ModelWorkspaceProps = {
  workproduct: LabWorkproductSummary;
  runs: CreateImproveRun[];
  training: TrainingController;
  onOpenDataset: (tasksetId: string) => void;
};

export function LabModelVersionsPage({
  workproduct,
  runs,
  training,
  onOpenDataset,
  onOpenEntry,
  onResumeDraft,
  onToast,
  readOnly = false,
}: ModelWorkspaceProps & {
  onOpenEntry: (entryKey: string) => void;
  onResumeDraft: (draftId: string) => void;
  onToast: ShowAppToast;
  readOnly?: boolean;
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
  const baselineRuns = useMemo(
    () => labModelBaselineRuns(workproduct, runs, state),
    [runs, state, workproduct]
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
    () =>
      modelVersionEntries(
        jobs,
        versions,
        baselineRuns,
        state?.modelRunDrafts.filter(
          (draft) =>
            draft.modelId === workproduct.id &&
            (draft.status === "draft" || draft.status === "ready_to_run")
        ) ?? []
      ),
    [baselineRuns, jobs, state?.modelRunDrafts, versions, workproduct.id]
  );
  const currentBinding = currentModelBinding(workproduct, runs, state);
  const baseVersion = labBaseModelVersion(workproduct, state);
  const lifecycleRuns = labLifecycleModelRuns(workproduct, state);
  const tasksets = labModelTasksets(state);

  async function setCurrent(versionId: string) {
    if (readOnly) return;
    const version = versions.find(
      (candidate) => candidate.lineage.id === versionId
    );
    if (!version || !resolveModelBindingPromotionGate(version.lineage)) return;
    if (
      !window.confirm(
        `Set Version ${version.number} as active for ${workproduct.name}?`
      )
    ) {
      return;
    }
    const result = await training.actions.bindModel(
      version.lineage.id,
      "chat_manual",
      workproduct.id
    );
    onToast(
      result
        ? `Version ${version.number} is now active.`
        : "The active Version could not be changed.",
      result ? "success" : "error"
    );
  }

  async function togglePinned(versionId: string, pinned: boolean) {
    if (readOnly) return;
    const result = await training.actions.setModelPinned(versionId, pinned);
    onToast(
      result
        ? pinned
          ? "Version pinned."
          : "Version unpinned."
        : "Version pin could not be changed.",
      result ? "success" : "error"
    );
  }

  return (
    <section
      className="labs-model-version-index"
      aria-label="Versions and runs"
    >
      {baseVersion ? (
        <DetailSection title="Base version 0">
          <div className="training-summary-grid">
            <Fact label="Base model" value={baseVersion.baseModel.modelId} />
            <Fact label="Profile" value={baseVersion.profileId} />
            <Fact label="Adapter" value="No adapter trained yet" />
            <Fact label="Status" value="Available" />
            <Fact
              label="Taskset"
              value={
                tasksets.find(
                  (taskset) => taskset.id === baseVersion.taskset.id
                )?.name ?? baseVersion.taskset.id
              }
            />
            <Fact
              label="Revision"
              value={baseVersion.baseModel.revision ?? "Unpinned"}
            />
          </div>
        </DetailSection>
      ) : null}
      {lifecycleRuns.length ? (
        <DetailSection title="Rollout runs">
          <div className="training-table-wrap">
            <table className="training-data-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Method</th>
                  <th>Taskset</th>
                  <th>Reward</th>
                  <th>Output</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {lifecycleRuns.map((run) => {
                  const taskset = tasksets.find(
                    (candidate) => candidate.id === run.taskset.id
                  );
                  return (
                    <tr key={run.id}>
                      <td>
                        <strong>{shortId(run.id)}</strong>
                      </td>
                      <td>
                        <LabStatusBadge
                          label={statusLabel(run.status)}
                          value={run.status}
                        />
                      </td>
                      <td>{trainingMethodLabel(run.method)}</td>
                      <td>
                        <button
                          className="labs-version-dataset-link"
                          type="button"
                          onClick={() => onOpenDataset(run.taskset.id)}
                        >
                          {taskset?.name ?? run.taskset.id}
                        </button>
                      </td>
                      <td>{run.reward ? run.reward.raw.toFixed(6) : "—"}</td>
                      <td>No adapter trained</td>
                      <td>{formatDateTime(run.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </DetailSection>
      ) : null}
      <div className="training-table-wrap">
        <table className="training-data-table labs-model-versions-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Training</th>
              <th>Taskset</th>
              <th>Training status</th>
              <th>Evaluation</th>
              <th>Output</th>
              <th>Updated</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {!entries.length && !lifecycleRuns.length ? (
              <tr>
                <td colSpan={8}>
                  <div className="training-run-placeholder">
                    No runs yet. Complete the build setup and start the first
                    run.
                  </div>
                </td>
              </tr>
            ) : null}
            {entries.map((entry) => {
              const baselineRun = entry.baselineRun;
              const draft = entry.draft;
              const plan =
                entry.version?.plan ??
                (entry.job ? planById.get(entry.job.planId) ?? null : null);
              const dataset =
                entry.version?.taskset ??
                tasksets.find(
                  (taskset) =>
                    taskset.id ===
                    (draft?.tasksetRef?.id ??
                      baselineRun?.tasksetId ??
                      plan?.tasksetId)
                ) ??
                null;
              const version = entry.version;
              const automaticallyPinned =
                version &&
                currentBinding?.modelArtifactLineageId === version.lineage.id;

              return (
                <tr
                  key={entry.key}
                  onClick={() =>
                    draft && !readOnly
                      ? onResumeDraft(draft.id)
                      : !draft
                      ? onOpenEntry(entry.key)
                      : undefined
                  }
                >
                  <td>
                    <button
                      className="labs-version-row-button"
                      type="button"
                      onClick={() =>
                        draft && !readOnly
                          ? onResumeDraft(draft.id)
                          : !draft
                          ? onOpenEntry(entry.key)
                          : undefined
                      }
                    >
                      <strong>
                        {draft
                          ? draft.title
                          : version
                          ? `Version ${version.number}`
                          : "Run"}
                      </strong>
                      <small>
                        {shortId(
                          draft?.id ??
                            version?.lineage.id ??
                            entry.job?.id ??
                            baselineRun?.id ??
                            entry.key
                        )}
                      </small>
                    </button>
                  </td>
                  <td>
                    {draft?.method
                      ? trainingMethodLabel(draft.method)
                      : baselineRun
                      ? baselineRun.configuration.split === "train"
                        ? "Train-signal check"
                        : "Base-model check"
                      : trainingMethodLabel(plan?.recipe.method)}
                  </td>
                  <td>
                    {dataset ? (
                      <button
                        className="labs-version-dataset-link"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenDataset(dataset.id);
                        }}
                      >
                        {dataset.name}
                      </button>
                    ) : (
                      "Unavailable"
                    )}
                  </td>
                  <td>
                    <LabStatusBadge
                      label={
                        draft
                          ? draft.status === "ready_to_run"
                            ? "Ready to run"
                            : "Draft"
                          : baselineRun
                          ? baselineRunStatusLabel(baselineRun)
                          : entry.job
                          ? statusLabel(entry.job.status)
                          : "Imported"
                      }
                      value={
                        draft?.status ??
                        baselineRun?.status ??
                        entry.job?.status ??
                        "completed"
                      }
                    />
                  </td>
                  <td>
                    {draft ? (
                      "—"
                    ) : baselineRun ? (
                      <BaselineRunProgressBadge run={baselineRun} />
                    ) : (
                      <VersionEvalBadge job={entry.job} version={version} />
                    )}
                  </td>
                  <td>
                    {draft ? (
                      "—"
                    ) : (
                      <VersionStatusBadge job={entry.job} version={version} />
                    )}
                  </td>
                  <td>
                    {formatDateTime(
                      draft?.updatedAt ??
                        version?.lineage.importedAt ??
                        baselineRun?.updatedAt ??
                        entry.job?.updatedAt ??
                        ""
                    )}
                  </td>
                  <td>
                    {draft ? (
                      <button
                        className="training-button secondary"
                        disabled={readOnly}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onResumeDraft(draft.id);
                        }}
                      >
                        Resume
                      </button>
                    ) : baselineRun && isActiveBaselineRun(baselineRun) ? (
                      <button
                        className="training-button secondary"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void training.actions.cancelBaselineRun(
                            baselineRun.id
                          );
                        }}
                      >
                        Cancel
                      </button>
                    ) : version ? (
                      <div className="training-table-actions">
                        <button
                          aria-pressed={
                            version.lineage.pinned ||
                            Boolean(automaticallyPinned)
                          }
                          className="labs-version-icon-button"
                          disabled={readOnly || Boolean(automaticallyPinned)}
                          title={
                            automaticallyPinned
                              ? "The active Version stays pinned"
                              : version.lineage.pinned
                              ? "Unpin Version"
                              : "Pin Version"
                          }
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void togglePinned(
                              version.lineage.id,
                              !version.lineage.pinned
                            );
                          }}
                        >
                          <Pin size={14} />
                        </button>
                        {!version.current ? (
                          <button
                            className="training-button secondary"
                            disabled={
                              readOnly ||
                              !resolveModelBindingPromotionGate(version.lineage)
                            }
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void setCurrent(version.lineage.id);
                            }}
                          >
                            Activate
                          </button>
                        ) : null}
                        <button
                          aria-label={`Download Version ${version.number}`}
                          className="labs-version-icon-button"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void training.actions.downloadModelPackage(
                              version.lineage.id
                            );
                          }}
                        >
                          <Download size={14} />
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function LabModelVersionDetailPage({
  connection,
  selectedEntryKey,
  workproduct,
  runs,
  training,
  onBack,
  onOpenDataset,
  onTabChange,
  onUseVersion,
  readOnly = false,
}: ModelWorkspaceProps & {
  connection: ClientConnection | null;
  selectedEntryKey: string;
  onBack: () => void;
  onTabChange?: (
    tab: "summary" | "metrics" | "evals" | "artifacts" | "logs"
  ) => void;
  onUseVersion: (versionId: string) => void;
  readOnly?: boolean;
}) {
  const [activeRunTab, setActiveRunTab] = useState<
    "summary" | "metrics" | "evals" | "artifacts" | "logs"
  >("summary");
  const state = training.payload;
  const jobs = useMemo(
    () => labModelJobs(workproduct, runs, state),
    [runs, state, workproduct]
  );
  const versions = useMemo(
    () => labModelVersions(workproduct, runs, state),
    [runs, state, workproduct]
  );
  const baselineRuns = useMemo(
    () => labModelBaselineRuns(workproduct, runs, state),
    [runs, state, workproduct]
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
    () => modelVersionEntries(jobs, versions, baselineRuns),
    [baselineRuns, jobs, versions]
  );
  const selected =
    entries.find((entry) => entry.key === selectedEntryKey) ?? null;
  const selectedJob = selected?.job ?? null;
  const selectedVersion = selected?.version ?? null;
  const selectedLifecycleRun = selectedJob
    ? state?.modelRuns.find(
        (run) => run.id === selectedJob.metadata.modelRunId
      ) ?? null
    : null;
  const selectedLifecycleVersion = selectedVersion
    ? state?.modelVersions.find(
        (version) => version.artifactLineageId === selectedVersion.lineage.id
      ) ?? null
    : null;
  const selectedBenchmarkRun = selectedLifecycleVersion
    ? state?.marketingBenchmarkRuns.find(
        (run) =>
          run.candidateModelVersionId === selectedLifecycleVersion.id &&
          run.status === "succeeded"
      ) ?? null
    : null;
  const selectedEvaluationArtifactId =
    selectedVersion?.lineage.frozenEvaluationArtifactId ?? null;
  const managedServing =
    selectedVersion?.lineage.managedServing ?? null;
  const selectedBaselineRun = selected?.baselineRun ?? null;
  const selectedPlan =
    selectedVersion?.plan ??
    (selectedJob ? planById.get(selectedJob.planId) ?? null : null);
  const selectedTaskset =
    selectedVersion?.taskset ??
    labModelTasksets(state).find(
      (taskset) =>
        taskset.id ===
        (selectedBaselineRun?.tasksetId ?? selectedPlan?.tasksetId)
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
  useEffect(() => {
    setActiveRunTab("summary");
    onTabChange?.("summary");
  }, [onTabChange, selectedEntryKey]);

  if (!selected) {
    return (
      <div className="labs-model-version-detail">
        <button
          className="settings-secondary compact"
          type="button"
          onClick={onBack}
        >
          Back to runs
        </button>
        <div className="training-run-placeholder">
          This training attempt is no longer available.
        </div>
      </div>
    );
  }

  return (
    <div className="labs-model-version-detail">
      <button
        className="settings-secondary compact labs-model-version-back"
        type="button"
        onClick={onBack}
      >
        Back to runs
      </button>

      <div
        className="training-detail-tabs"
        role="tablist"
        aria-label="Run detail"
      >
        {(
          [
            ["summary", "Summary"],
            ["metrics", "Metrics"],
            ["evals", "Evals"],
            ["artifacts", "Artifacts"],
            ["logs", "Logs"],
          ] as const
        ).map(([id, label]) => (
          <button
            aria-selected={activeRunTab === id}
            className={activeRunTab === id ? "active" : undefined}
            key={id}
            role="tab"
            type="button"
            onClick={() => {
              setActiveRunTab(id);
              onTabChange?.(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {activeRunTab === "summary" ? (
        <DetailSection
          title={
            selectedBaselineRun
              ? selectedBaselineRun.configuration.split === "train"
                ? "Train-signal check"
                : "Base-model check"
              : selectedVersion
              ? `Version ${selectedVersion.number}`
              : `${trainingMethodLabel(selectedPlan?.recipe.method)} attempt`
          }
          actions={
            selectedBaselineRun && isActiveBaselineRun(selectedBaselineRun) ? (
              <button
                className="training-button secondary"
                type="button"
                onClick={() =>
                  void training.actions.cancelBaselineRun(
                    selectedBaselineRun.id
                  )
                }
              >
                Cancel check
              </button>
            ) : selectedVersion ? (
              <div className="training-table-actions">
                {selectedTaskset ? (
                  <button
                    className="training-button secondary"
                    disabled={
                      readOnly ||
                      !resolveModelBindingPromotionGate(selectedVersion.lineage)
                    }
                    title={
                      resolveModelBindingPromotionGate(selectedVersion.lineage)
                        ? "Chat with this Version"
                        : "Chat is unavailable because this Version did not pass evaluation."
                    }
                    type="button"
                    onClick={() => onUseVersion(selectedVersion.lineage.id)}
                  >
                    <MessageSquare size={14} />
                    Chat
                  </button>
                ) : null}
                <button
                  className="training-button secondary"
                  type="button"
                  onClick={() =>
                    void training.actions.downloadModelPackage(
                      selectedVersion.lineage.id
                    )
                  }
                >
                  <Download size={14} />
                  Download LoRA
                </button>
              </div>
            ) : null
          }
        >
          <dl className="labs-inline-facts">
            <Fact
              label={selectedBaselineRun ? "Check status" : "Training status"}
              value={
                selectedBaselineRun
                  ? baselineRunStatusLabel(selectedBaselineRun)
                  : selectedJob
                  ? statusLabel(selectedJob.status)
                  : "Imported"
              }
            />
            <Fact
              label="Version status"
              value={
                selectedVersion
                  ? selectedVersion.current
                    ? "Active"
                    : "Available"
                  : "Not created"
              }
            />
            <Fact
              label="Training"
              value={
                selectedBaselineRun
                  ? "RFT readiness check"
                  : trainingMethodLabel(selectedPlan?.recipe.method)
              }
            />
            <Fact
              label="Base model"
              value={
                selectedBaselineRun
                  ? modelRefName(
                      selectedBaselineRun.configuration.model.modelId
                    )
                  : baseModelName(selectedPlan)
              }
            />
            <Fact
              label="Taskset"
              value={selectedTaskset?.name ?? "Unavailable"}
            />
            <Fact
              label="Compute"
              value={
                selectedBaselineRun
                  ? "Fireworks"
                  : selectedPlan
                  ? destinationLabel(selectedPlan.destinationId)
                  : selectedJob
                  ? destinationLabel(selectedJob.destinationId)
                  : "Not recorded"
              }
            />
            <Fact
              label="Duration"
              value={
                selectedBaselineRun
                  ? formatDuration(
                      selectedBaselineRun.startedAt,
                      selectedBaselineRun.completedAt
                    )
                  : selectedJob
                  ? formatDuration(
                      selectedJob.startedAt,
                      selectedJob.completedAt
                    )
                  : "Not recorded"
              }
            />
            <Fact
              label="Output"
              value={
                selectedVersion
                  ? `Version ${selectedVersion.number}`
                  : selectedBaselineRun?.reportId
                  ? "Check report"
                  : "No Version"
              }
            />
          </dl>
          {selectedTaskset ? (
            <button
              className="labs-version-dataset-link labs-version-detail-dataset"
              type="button"
              onClick={() => onOpenDataset(selectedTaskset.id)}
            >
              Open {selectedTaskset.name}
            </button>
          ) : null}
          {selectedBaselineRun?.error || selectedJob?.error ? (
            <p className="labs-training-error">
              {selectedBaselineRun?.error ?? selectedJob?.error}
            </p>
          ) : null}
          {selectedLifecycleRun?.receipt?.telemetry ? (
            <div className="training-run-evaluation">
              <div className="training-evaluation-facts">
                <Fact
                  label="GPU"
                  value={`${
                    selectedLifecycleRun.receipt.telemetry.resource.gpuCount ??
                    0
                  } × ${
                    selectedLifecycleRun.receipt.telemetry.resource.gpuType ??
                    "unreported"
                  }`}
                />
                <Fact
                  label="Tokens"
                  value={`${
                    selectedLifecycleRun.receipt.telemetry.usage.promptTokens ??
                    0
                  } prompt · ${
                    selectedLifecycleRun.receipt.telemetry.usage
                      .generatedTokens ?? 0
                  } generated`}
                />
                <Fact
                  label="Trajectories"
                  value={`${
                    selectedLifecycleRun.receipt.telemetry.usage
                      .successfulTrajectories ?? 0
                  } succeeded · ${
                    selectedLifecycleRun.receipt.telemetry.usage
                      .failedTrajectories ?? 0
                  } failed`}
                />
                <Fact
                  label="GPU time"
                  value={`${
                    selectedLifecycleRun.receipt.telemetry.usage.gpuSeconds?.toFixed(
                      1
                    ) ?? "0.0"
                  } seconds`}
                />
                <Fact
                  label={
                    selectedLifecycleRun.receipt.telemetry.cost
                      .providerReportedUsd === null
                      ? "Estimated cost"
                      : "Provider-reported cost"
                  }
                  value={`$${(
                    selectedLifecycleRun.receipt.telemetry.cost
                      .providerReportedUsd ??
                    selectedLifecycleRun.receipt.telemetry.cost.estimatedUsd ??
                    0
                  ).toFixed(4)}`}
                />
                <Fact
                  label="Optimizer"
                  value={`${
                    selectedLifecycleRun.receipt.telemetry.usage
                      .optimizerSteps ?? 0
                  } step`}
                />
              </div>
              <button
                className="training-button secondary"
                type="button"
                onClick={() =>
                  downloadCanonicalJson(
                    `${selectedLifecycleRun.id}-receipt.json`,
                    selectedLifecycleRun.receipt
                  )
                }
              >
                <Download size={14} />
                Download Model Run receipt
              </button>
            </div>
          ) : null}
        </DetailSection>
      ) : null}
      {activeRunTab === "summary" ? (
        <ManagedAdapterServingEvidence projection={managedServing} />
      ) : null}

      {selectedJob && activeRunTab === "metrics" ? (
        <>
          <DetailSection
            title={
              selectedPlan?.recipe.method === "grpo"
                ? "Rollout scores"
                : "Training metrics"
            }
          >
            <TrainingRunMetrics
              detail={detail.detail}
              error={detail.error}
              loading={detail.loading}
            />
          </DetailSection>
          {selectedPlan?.recipe.method === "grpo" ? (
            <DetailSection title="Rollout traces">
              <TrainingRolloutReceipts receipts={receipts} />
            </DetailSection>
          ) : null}
        </>
      ) : null}

      {activeRunTab === "evals" ? (
        <>
          <DetailSection title="Product-quality evaluation">
            {selectedBenchmarkRun?.receipt ? (
              <div className="training-run-evaluation">
                <div className="training-evaluation-facts">
                  <Fact
                    label="Base Qwen3-0.6B"
                    value={selectedBenchmarkRun.receipt.aggregate.base.meanReward.toFixed(
                      3
                    )}
                  />
                  <Fact
                    label="Trained LoRA"
                    value={selectedBenchmarkRun.receipt.aggregate.candidate.meanReward.toFixed(
                      3
                    )}
                  />
                  <Fact
                    label="GPT-5.6 Sol"
                    value={selectedBenchmarkRun.receipt.aggregate.frontier_reference.meanReward.toFixed(
                      3
                    )}
                  />
                  <Fact
                    label="Promotion"
                    value={
                      selectedBenchmarkRun.receipt.pairedComparison
                        .candidatePromotionPassed
                        ? "Passed"
                        : "Rejected"
                    }
                  />
                </div>
                <p className="training-muted">
                  {selectedBenchmarkRun.receipt.disclosure}
                </p>
                <details>
                  <summary>96 paired tool trajectories</summary>
                  <ol>
                    {selectedBenchmarkRun.receipt.trajectories.map(
                      (trajectory) => (
                        <li
                          key={`${trajectory.arm}:${trajectory.taskId}:${trajectory.attempt}`}
                        >
                          {trajectory.arm.replaceAll("_", " ")} ·{" "}
                          {trajectory.taskId} · attempt {trajectory.attempt + 1} ·{" "}
                          {trajectory.reward?.toFixed(3) ?? "n/a"} ·{" "}
                          {trajectory.toolSequence.join(" → ") ||
                            trajectory.failureClass}
                        </li>
                      )
                    )}
                  </ol>
                </details>
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
                    Download canonical receipt
                  </button>
                ) : null}
              </div>
            ) : (
              <TrainingRunEvaluation
                detail={detail.detail}
                loading={detail.loading}
              />
            )}
          </DetailSection>
          {managedServing?.evaluation ? (
            <DetailSection title="Sandbox compatibility and admission">
              <ManagedAdapterEvaluationPanel
                evaluation={managedServing.evaluation}
              />
            </DetailSection>
          ) : null}
        </>
      ) : null}

      {activeRunTab === "artifacts" ? (
        <DetailSection title="Configuration and artifacts">
          <dl className="training-configuration-list">
            <Fact
              label={selectedBaselineRun ? "Check run" : "Training attempt"}
              value={
                selectedBaselineRun?.id ?? selectedJob?.id ?? "Provider import"
              }
            />
            <Fact
              label="Taskset"
              value={selectedTaskset?.name ?? "Unavailable"}
            />
            <Fact
              label={selectedBaselineRun ? "Selection" : "Prepared data"}
              value={
                selectedBaselineRun
                  ? `${selectedBaselineRun.configuration.taskLimit} prompts × ${selectedBaselineRun.configuration.attemptsPerTask} attempts`
                  : selectedJob?.bundleHash ?? "Provider managed"
              }
            />
            <Fact
              label={selectedBaselineRun ? "Provider deployment" : "Version ID"}
              value={
                selectedBaselineRun
                  ? selectedBaselineRun.provider?.deploymentId ??
                    "Not provisioned"
                  : selectedVersion?.lineage.id ?? "No Version created"
              }
            />
            {selectedBaselineRun ? (
              <Fact
                label="Attempt progress"
                value={`${selectedBaselineRun.progress.completedAttempts} of ${selectedBaselineRun.progress.totalAttempts}`}
              />
            ) : null}
            {selectedBaselineRun?.provider?.statusCode ? (
              <Fact
                label="Provider status"
                value={selectedBaselineRun.provider.statusCode}
              />
            ) : null}
          </dl>
        </DetailSection>
      ) : null}

      {activeRunTab === "logs" ? (
        selectedJob ? (
          <TrainingEventLog
            error={selectedJob.error ?? detail.error}
            events={detail.detail?.events ?? []}
            loading={detail.loading}
          />
        ) : (
          <div className="training-run-placeholder">
            {selectedBaselineRun?.error ?? "No run log entries yet."}
          </div>
        )
      ) : null}
    </div>
  );
}

function downloadCanonicalJson(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function modelVersionEntries(
  jobs: TrainingJob[],
  versions: LabModelVersion[],
  baselineRuns: TasksetBaselineRun[],
  drafts: ModelRunDraft[] = []
): VersionEntry[] {
  const versionByJobId = new Map(
    versions.flatMap((version) =>
      version.job ? [[version.job.id, version] as const] : []
    )
  );
  const entries: VersionEntry[] = jobs.map((job) => ({
    key: `job:${job.id}`,
    job,
    version: versionByJobId.get(job.id) ?? null,
    baselineRun: null,
    draft: null,
  }));
  const knownJobIds = new Set(jobs.map((job) => job.id));
  for (const version of versions) {
    if (version.job && knownJobIds.has(version.job.id)) continue;
    entries.push({
      key: `version:${version.lineage.id}`,
      job: version.job,
      version,
      baselineRun: null,
      draft: null,
    });
  }
  for (const baselineRun of baselineRuns) {
    entries.push({
      key: `baseline:${baselineRun.id}`,
      job: null,
      version: null,
      baselineRun,
      draft: null,
    });
  }
  for (const draft of drafts) {
    entries.push({
      key: `draft:${draft.id}`,
      job: null,
      version: null,
      baselineRun: null,
      draft,
    });
  }
  return entries.sort((left, right) =>
    entryTimestamp(right).localeCompare(entryTimestamp(left))
  );
}

function entryTimestamp(entry: VersionEntry): string {
  return (
    entry.version?.lineage.importedAt ??
    entry.draft?.updatedAt ??
    entry.baselineRun?.updatedAt ??
    entry.job?.updatedAt ??
    entry.job?.createdAt ??
    ""
  );
}

function baselineRunStatusLabel(run: TasksetBaselineRun): string {
  switch (run.status) {
    case "queued":
      return "Check queued";
    case "preparing":
      return "Preparing check";
    case "running":
      return "Check running";
    case "cancelling":
      return "Cancelling check";
    case "cancelled":
      return "Check cancelled";
    case "succeeded":
      return "Check passed";
    case "failed":
      return "Check failed";
  }
}

function isActiveBaselineRun(run: TasksetBaselineRun): boolean {
  return ["queued", "preparing", "running", "cancelling"].includes(run.status);
}

function BaselineRunProgressBadge({ run }: { run: TasksetBaselineRun }) {
  const progress = `${run.progress.completedAttempts} / ${run.progress.totalAttempts}`;
  const label = run.reportId
    ? "Recorded"
    : run.progress.completedAttempts
    ? progress
    : "No attempts";
  return (
    <LabStatusBadge
      label={label}
      value={
        run.reportId
          ? "passed"
          : isActiveBaselineRun(run)
          ? "running"
          : run.status
      }
    />
  );
}

function VersionEvalBadge({
  job,
  version,
}: {
  job: TrainingJob | null;
  version: LabModelVersion | null;
}) {
  const evaluationComplete = version
    ? Boolean(resolveModelBindingPromotionGate(version.lineage)) ||
      job?.metadata.frozenEvaluationComplete === true ||
      Boolean(version.lineage.frozenEvaluationArtifactId) ||
      Boolean(version.lineage.managedServing?.evaluation)
    : false;
  const evaluationPassed = version
    ? Boolean(resolveModelBindingPromotionGate(version.lineage)) ||
      managedAdapterEvaluationPassed(version.lineage)
    : false;
  const label = version
    ? !evaluationComplete
      ? "Not run"
      : evaluationPassed
      ? "Passed"
      : "Failed"
    : job &&
      ["queued", "starting", "running", "cancelling", "reconciling"].includes(
        job.status
      )
    ? "Pending"
    : "Not run";
  const value = version
    ? evaluationPassed
      ? "passed"
      : evaluationComplete
      ? "failed"
      : "not_run"
    : "not_run";
  return <LabStatusBadge label={label} value={value} />;
}

function VersionStatusBadge({
  job,
  version,
}: {
  job: TrainingJob | null;
  version: LabModelVersion | null;
}) {
  const pending = Boolean(
    job &&
      ["queued", "starting", "running", "cancelling", "reconciling"].includes(
        job.status
      )
  );
  return (
    <LabStatusBadge
      label={
        version
          ? version.current
            ? "Active"
            : "Available"
          : pending
          ? "Pending"
          : "Not created"
      }
      value={
        version
          ? version.current
            ? "current"
            : "ready"
          : pending
          ? "running"
          : "not_run"
      }
    />
  );
}

function baseModelName(plan: ReturnType<typeof labModelPlans>[number] | null) {
  if (!plan) return "Not recorded";
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

function shortId(value: string) {
  return value
    .replace(/^baseline_run_/, "")
    .replace(/^(?:training_job_|lineage_)(?:fireworks_)?(?:artifact_)?/, "")
    .slice(0, 12);
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
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
    <div className="training-table-wrap">
      <table className="training-data-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{formatDateTime(event.timestamp)}</td>
              <td>{eventLabel(event.type)}</td>
              <td>{eventSummary(event)}</td>
            </tr>
          ))}
          {error ? (
            <tr>
              <td>—</td>
              <td>Failure</td>
              <td>{error}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function eventLabel(type: TrainingJobEvent["type"]): string {
  return type
    .replaceAll("_", " ")
    .replace(/^./, (value) => value.toUpperCase());
}

function eventSummary(event: TrainingJobEvent): string {
  const payload = event.payload;
  const step = finiteNumber(payload.step);
  const maxSteps = finiteNumber(payload.maxSteps);
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
    return `${kind}${step == null ? "" : ` · step ${step}`}${
      values.length ? ` · ${values.join(" · ")}` : ""
    }`;
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
