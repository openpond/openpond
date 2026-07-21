import { useMemo } from "react";
import type {
  CreateImproveRun,
  TasksetBaselineRun,
  TrainingJob,
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
  currentModelBinding,
  labModelBaselineRuns,
  labModelJobs,
  labModelPlans,
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
  onToast,
}: ModelWorkspaceProps & {
  onOpenEntry: (entryKey: string) => void;
  onToast: ShowAppToast;
}) {
  const state = training.payload;
  const jobs = useMemo(
    () => labModelJobs(workproduct, runs, state),
    [runs, state, workproduct],
  );
  const versions = useMemo(
    () => labModelVersions(workproduct, runs, state),
    [runs, state, workproduct],
  );
  const baselineRuns = useMemo(
    () => labModelBaselineRuns(workproduct, runs, state),
    [runs, state, workproduct],
  );
  const plans = useMemo(
    () => labModelPlans(workproduct, runs, state),
    [runs, state, workproduct],
  );
  const planById = useMemo(
    () => new Map(plans.map((plan) => [plan.id, plan] as const)),
    [plans],
  );
  const entries = useMemo(
    () => modelVersionEntries(jobs, versions, baselineRuns),
    [baselineRuns, jobs, versions],
  );
  const currentBinding = currentModelBinding(workproduct, runs, state);

  async function setCurrent(versionId: string) {
    const version = versions.find(
      (candidate) => candidate.lineage.id === versionId,
    );
    if (!version?.lineage.promotable) return;
    if (
      !window.confirm(
        `Set Version ${version.number} as active for ${workproduct.name}?`,
      )
    ) {
      return;
    }
    const result = await training.actions.bindModel(
      version.lineage.id,
      "chat_manual",
      workproduct.id,
    );
    onToast(
      result
        ? `Version ${version.number} is now active.`
        : "The active Version could not be changed.",
      result ? "success" : "error",
    );
  }

  async function togglePinned(versionId: string, pinned: boolean) {
    const result = await training.actions.setModelPinned(versionId, pinned);
    onToast(
      result
        ? pinned
          ? "Version pinned."
          : "Version unpinned."
        : "Version pin could not be changed.",
      result ? "success" : "error",
    );
  }

  return (
    <section className="labs-model-version-index" aria-label="Versions">
      <div className="training-table-wrap">
        <table className="training-data-table labs-model-versions-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Training</th>
              <th>Dataset</th>
              <th>Training status</th>
              <th>Evaluation</th>
              <th>Version status</th>
              <th>Updated</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {!entries.length ? (
              <tr>
                <td colSpan={8}>
                  <div className="training-run-placeholder">
                    No training attempts yet. Create the first Version and
                    finish its Dataset checks.
                  </div>
                </td>
              </tr>
            ) : null}
            {entries.map((entry) => {
              const baselineRun = entry.baselineRun;
              const plan =
                entry.version?.plan ??
                (entry.job ? planById.get(entry.job.planId) ?? null : null);
              const dataset =
                entry.version?.taskset ??
                state?.tasksets.find(
                  (taskset) =>
                    taskset.id === (baselineRun?.tasksetId ?? plan?.tasksetId),
                ) ??
                null;
              const version = entry.version;
              const automaticallyPinned =
                version &&
                currentBinding?.modelArtifactLineageId === version.lineage.id;

              return (
                <tr key={entry.key} onClick={() => onOpenEntry(entry.key)}>
                  <td>
                    <button
                      className="labs-version-row-button"
                      type="button"
                      onClick={() => onOpenEntry(entry.key)}
                    >
                      <strong>
                        {version ? `Version ${version.number}` : "No output"}
                      </strong>
                      <small>
                        {shortId(
                          version?.lineage.id ??
                            entry.job?.id ??
                            baselineRun?.id ??
                            entry.key,
                        )}
                      </small>
                    </button>
                  </td>
                  <td>
                    {baselineRun
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
                        baselineRun
                          ? baselineRunStatusLabel(baselineRun)
                          : entry.job
                            ? statusLabel(entry.job.status)
                            : "Imported"
                      }
                      value={
                        baselineRun?.status ??
                        entry.job?.status ??
                        "completed"
                      }
                    />
                  </td>
                  <td>
                    {baselineRun ? (
                      <BaselineRunProgressBadge run={baselineRun} />
                    ) : (
                      <VersionEvalBadge version={version} />
                    )}
                  </td>
                  <td>
                    <VersionStatusBadge version={version} />
                  </td>
                  <td>
                    {formatDateTime(
                      version?.lineage.importedAt ??
                        baselineRun?.updatedAt ??
                        entry.job?.updatedAt ??
                        "",
                    )}
                  </td>
                  <td>
                    {baselineRun && isActiveBaselineRun(baselineRun) ? (
                      <button
                        className="training-button secondary"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void training.actions.cancelBaselineRun(baselineRun.id);
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
                          disabled={Boolean(automaticallyPinned)}
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
                              !version.lineage.pinned,
                            );
                          }}
                        >
                          <Pin size={14} />
                        </button>
                        {!version.current ? (
                          <button
                            className="training-button secondary"
                            disabled={!version.lineage.promotable}
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
                              version.lineage.id,
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
  onUseVersion,
}: ModelWorkspaceProps & {
  connection: ClientConnection | null;
  selectedEntryKey: string;
  onBack: () => void;
  onUseVersion: (versionId: string) => void;
}) {
  const state = training.payload;
  const jobs = useMemo(
    () => labModelJobs(workproduct, runs, state),
    [runs, state, workproduct],
  );
  const versions = useMemo(
    () => labModelVersions(workproduct, runs, state),
    [runs, state, workproduct],
  );
  const baselineRuns = useMemo(
    () => labModelBaselineRuns(workproduct, runs, state),
    [runs, state, workproduct],
  );
  const plans = useMemo(
    () => labModelPlans(workproduct, runs, state),
    [runs, state, workproduct],
  );
  const planById = useMemo(
    () => new Map(plans.map((plan) => [plan.id, plan] as const)),
    [plans],
  );
  const entries = useMemo(
    () => modelVersionEntries(jobs, versions, baselineRuns),
    [baselineRuns, jobs, versions],
  );
  const selected =
    entries.find((entry) => entry.key === selectedEntryKey) ?? null;
  const selectedJob = selected?.job ?? null;
  const selectedVersion = selected?.version ?? null;
  const selectedBaselineRun = selected?.baselineRun ?? null;
  const selectedPlan =
    selectedVersion?.plan ??
    (selectedJob ? planById.get(selectedJob.planId) ?? null : null);
  const selectedTaskset =
    selectedVersion?.taskset ??
    state?.tasksets.find(
      (taskset) =>
        taskset.id ===
        (selectedBaselineRun?.tasksetId ?? selectedPlan?.tasksetId),
    ) ??
    null;
  const detail = useTrainingRunDetail(
    connection,
    selectedJob?.id ?? null,
    selectedJob?.status ?? null,
  );
  const receipts = selectedJob
    ? state?.rolloutReceipts.filter(
        (receipt) => receipt.jobId === selectedJob.id,
      ) ?? []
    : [];

  if (!selected) {
    return (
      <div className="labs-model-version-detail">
        <button
          className="settings-secondary compact"
          type="button"
          onClick={onBack}
        >
          Back to versions
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
        Back to versions
      </button>

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
                void training.actions.cancelBaselineRun(selectedBaselineRun.id)
              }
            >
              Cancel check
            </button>
          ) : selectedVersion ? (
            <div className="training-table-actions">
              {selectedTaskset ? (
                <button
                  className="training-button secondary"
                  disabled={!selectedVersion.lineage.promotable}
                  title={
                    selectedVersion.lineage.promotable
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
                    selectedVersion.lineage.id,
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
                ? modelRefName(selectedBaselineRun.configuration.model.modelId)
                : baseModelName(selectedPlan)
            }
          />
          <Fact
            label="Dataset"
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
                    selectedBaselineRun.completedAt,
                  )
                : selectedJob
                  ? formatDuration(
                      selectedJob.startedAt,
                      selectedJob.completedAt,
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
      </DetailSection>

      {selectedJob ? (
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
          <DetailSection title="Evaluation">
            <TrainingRunEvaluation
              detail={detail.detail}
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

      <DetailSection title="Configuration">
        <dl className="training-configuration-list">
          <Fact
            label={selectedBaselineRun ? "Check run" : "Training attempt"}
            value={
              selectedBaselineRun?.id ?? selectedJob?.id ?? "Provider import"
            }
          />
          <Fact
            label="Dataset"
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
                ? selectedBaselineRun.provider?.deploymentId ?? "Not provisioned"
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
    </div>
  );
}

function modelVersionEntries(
  jobs: TrainingJob[],
  versions: LabModelVersion[],
  baselineRuns: TasksetBaselineRun[],
): VersionEntry[] {
  const versionByJobId = new Map(
    versions.flatMap((version) =>
      version.job ? [[version.job.id, version] as const] : [],
    ),
  );
  const entries: VersionEntry[] = jobs.map((job) => ({
    key: `job:${job.id}`,
    job,
    version: versionByJobId.get(job.id) ?? null,
    baselineRun: null,
  }));
  const knownJobIds = new Set(jobs.map((job) => job.id));
  for (const version of versions) {
    if (version.job && knownJobIds.has(version.job.id)) continue;
    entries.push({
      key: `version:${version.lineage.id}`,
      job: version.job,
      version,
      baselineRun: null,
    });
  }
  for (const baselineRun of baselineRuns) {
    entries.push({
      key: `baseline:${baselineRun.id}`,
      job: null,
      version: null,
      baselineRun,
    });
  }
  return entries.sort((left, right) =>
    entryTimestamp(right).localeCompare(entryTimestamp(left)),
  );
}

function entryTimestamp(entry: VersionEntry): string {
  return (
    entry.version?.lineage.importedAt ??
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
  return ["queued", "preparing", "running", "cancelling"].includes(
    run.status,
  );
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
  version,
}: {
  version: LabModelVersion | null;
}) {
  const label = version
    ? version.lineage.promotable
      ? "Passed"
      : version.lineage.frozenEvaluationArtifactId
        ? "Failed"
        : "Not run"
    : "No output";
  const value = version
    ? version.lineage.promotable
      ? "passed"
      : version.lineage.frozenEvaluationArtifactId
        ? "failed"
        : "not_run"
    : "not_run";
  return <LabStatusBadge label={label} value={value} />;
}

function VersionStatusBadge({
  version,
}: {
  version: LabModelVersion | null;
}) {
  return (
    <LabStatusBadge
      label={
        version ? (version.current ? "Active" : "Available") : "Not created"
      }
      value={version ? (version.current ? "current" : "ready") : "not_run"}
    />
  );
}

function baseModelName(plan: ReturnType<typeof labModelPlans>[number] | null) {
  if (
    !plan ||
    (plan.recipe.method !== "sft" && plan.recipe.method !== "grpo")
  ) {
    return "Not recorded";
  }
  return plan.recipe.baseModel.id.split("/").at(-1) ?? plan.recipe.baseModel.id;
}

function modelRefName(modelId: string) {
  return modelId.split("/").at(-1) ?? modelId;
}

function shortId(value: string) {
  return value
    .replace(/^baseline_run_/, "")
    .replace(
      /^(?:training_job_|lineage_)(?:fireworks_)?(?:artifact_)?/,
      "",
    )
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
