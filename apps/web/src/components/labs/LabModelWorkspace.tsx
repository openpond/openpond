import { useMemo, useState } from "react";
import type {
  CreateImproveRun,
  ModelComparisonSeriesEntry,
  ModelRun,
  TrainingJob,
  TrainingMethod,
} from "@openpond/contracts";
import {
  managedAdapterCustomerBindingAllowed,
  resolveModelBindingEligibility,
  resolveModelBindingPromotionGate,
} from "@openpond/contracts";

import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import { useLiveClock } from "../../hooks/useLiveClock";
import { Download, Pin } from "../icons";
import {
  formatDuration,
  formatDateTime,
  terminalRunEnd,
  trainingMethodLabel,
} from "../training/training-model-data";
import { LabStatusBadge } from "./LabStatusBadge";
import {
  isActiveRunStatus,
  LabRunStatusBadge,
  resolveRunStatus,
} from "./LabRunStatusBadge";
import {
  currentModelBinding,
  labLifecycleModelRuns,
  labModelJobs,
  labModelPlans,
  labModelTasksets,
  labModelVersions,
} from "./lab-models";
import type { LabWorkproductSummary } from "./lab-workproducts";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";

type TrainingController = ReturnType<typeof useTraining>;
type LabModelVersion = ReturnType<typeof labModelVersions>[number];
type VersionEntry = {
  key: string;
  job: TrainingJob | null;
  version: LabModelVersion | null;
};
export type RunEntry = {
  key: string;
  job: TrainingJob | null;
  lifecycleRun: ModelRun | null;
  version: LabModelVersion | null;
};

export type ModelWorkspaceProps = {
  workproduct: LabWorkproductSummary;
  runs: CreateImproveRun[];
  training: TrainingController;
  onOpenDataset: (tasksetId: string) => void;
};

export function LabModelRunsPage({
  workproduct,
  runs,
  training,
  onOpenDataset,
  onOpenEntry,
  onNewRun,
  readOnly = false,
  mode = "training",
}: ModelWorkspaceProps & {
  onOpenEntry: (entryKey: string) => void;
  onNewRun: () => void;
  readOnly?: boolean;
  mode?: "training" | "evals";
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
  const plans = useMemo(
    () => labModelPlans(workproduct, runs, state),
    [runs, state, workproduct]
  );
  const planById = useMemo(
    () => new Map(plans.map((plan) => [plan.id, plan] as const)),
    [plans]
  );
  const lifecycleRuns = labLifecycleModelRuns(workproduct, state);
  const tasksets = labModelTasksets(state);
  const comparisonEntries = state?.comparisonSeriesEntries ?? [];
  const runEntries = useMemo(() => {
    const entries = modelRunEntries(jobs, versions, lifecycleRuns);
    return modelRunEntriesForMode(entries, mode);
  }, [jobs, lifecycleRuns, mode, versions]);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const visibleRunEntries = showAllRuns
    ? runEntries
    : runEntries.slice(0, 5);
  const submittedRunCount = runEntries.length;
  const hasActiveRun = runEntries.some((entry) =>
    isActiveRunStatus(resolveRunStatus(entry)),
  );
  const liveNow = useLiveClock(hasActiveRun);
  const runNumberByKey = useMemo(() => {
    let runNumber = submittedRunCount;
    const numbers = new Map<string, number>();
    for (const entry of runEntries) {
      numbers.set(entry.key, runNumber);
      runNumber -= 1;
    }
    return numbers;
  }, [runEntries, submittedRunCount]);

  function selectEntry(entry: RunEntry) {
    onOpenEntry(entry.key);
  }

  return (
    <section className="labs-model-version-index" aria-label="Model runs">
      <ModelProjectPageHeader
        title={mode === "evals" ? "Evaluations" : "Training Runs"}
        description={mode === "evals"
          ? "Evaluation-only runs, held-out results, and grader evidence."
          : "Training runs, optimizer progress, checkpoints, and immutable outputs."}
        actions={!readOnly && mode === "training" ? (
            <button
              className="training-button"
              type="button"
              onClick={onNewRun}
            >
              New training run
            </button>
        ) : null}
      />
      <div className="training-table-wrap">
        <table className="training-data-table labs-model-runs-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th>Method</th>
              <th>Based on</th>
              <th>Taskset</th>
              <th>Result</th>
              <th>Duration</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {!runEntries.length ? (
              <tr>
                <td colSpan={8}>
                  <div className="training-run-placeholder">
                    No runs yet.
                  </div>
                </td>
              </tr>
            ) : null}
            {visibleRunEntries.map((entry) => {
              const runNumber = runNumberByKey.get(entry.key) ?? null;
              const plan =
                entry.version?.plan ??
                (entry.job ? planById.get(entry.job.planId) ?? null : null);
              const dataset =
                entry.version?.taskset ??
                tasksets.find(
                  (taskset) =>
                    taskset.id ===
                    (entry.lifecycleRun?.taskset.id ??
                      plan?.tasksetId)
                ) ??
                null;
              const version = entry.version;

              return (
                <tr
                  key={entry.key}
                  onClick={() => selectEntry(entry)}
                >
                  <td>
                    <button
                      className="labs-version-row-button"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        selectEntry(entry);
                      }}
                    >
                      <strong>{`Run ${runNumber}`}</strong>
                      <small>
                        {version
                          ? `Created Version ${version.number}`
                          : entry.lifecycleRun?.kind === "evaluation"
                          ? "Evaluation"
                          : entry.lifecycleRun?.kind === "rollout_smoke"
                          ? "Preflight rollout"
                          : "Training"}
                      </small>
                    </button>
                  </td>
                  <td>
                    <LabRunStatusBadge status={resolveRunStatus(entry)} />
                  </td>
                  <td>
                    {entry.lifecycleRun?.kind === "evaluation"
                      ? "Evaluation"
                      : trainingMethodLabel(
                          entry.lifecycleRun?.method ??
                            plan?.recipe.method ??
                            hostedTrainingMethod(entry.job)
                        )}
                  </td>
                  <td>{runBasedOn(entry.lifecycleRun, comparisonEntries, entry.job)}</td>
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
                    ) : typeof entry.job?.metadata.tasksetId === "string" ? (
                      entry.job.metadata.tasksetId
                    ) : (
                      "Unavailable"
                    )}
                  </td>
                  <td>{runResult(entry)}</td>
                  <td>{runDuration(entry, liveNow)}</td>
                  <td>
                    {formatDateTime(
                      entry.lifecycleRun?.updatedAt ??
                        version?.lineage.importedAt ??
                        entry.job?.updatedAt ??
                      ""
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {runEntries.length > 5 ? (
        <div className="labs-model-run-list-actions">
          <button
            className="training-button secondary labs-compact-button"
            type="button"
            onClick={() => setShowAllRuns((visible) => !visible)}
          >
            {showAllRuns
              ? "Show latest 5"
              : `Show all ${runEntries.length} activities`}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function LabModelVersionsPage({
  workproduct,
  runs,
  training,
  onOpenDataset,
  onOpenEntry,
  onToast,
  readOnly = false,
}: ModelWorkspaceProps & {
  onOpenEntry: (entryKey: string) => void;
  onToast: ShowAppToast;
  readOnly?: boolean;
}) {
  const state = training.payload;
  const versions = useMemo(
    () => labModelVersions(workproduct, runs, state),
    [runs, state, workproduct]
  );
  const currentBinding = currentModelBinding(workproduct, runs, state);

  async function setCurrent(versionId: string) {
    if (readOnly) return;
    const version = versions.find(
      (candidate) => candidate.lineage.id === versionId
    );
    if (!version || !resolveModelBindingEligibility(version.lineage)) return;
    if (
      !window.confirm(
        `Set Version ${version.number} as the default for ${workproduct.name}?`
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
        ? `Version ${version.number} is now the project default.`
        : "The default Version could not be changed.",
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
    <section className="labs-model-version-index" aria-label="Model versions">
      <header className="labs-model-section-intro">
        <div>
          <h1>Model Versions</h1>
          <p>
            Trained outputs that can be evaluated, served, and selected as the project default.
          </p>
        </div>
        <span>{versions.length} trained</span>
      </header>

      <div className="training-table-wrap">
        <table className="training-data-table labs-model-versions-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Status</th>
              <th>Training</th>
              <th>Taskset</th>
              <th>Evaluation</th>
              <th>Created</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {!versions.length ? (
              <tr>
                <td colSpan={7}>
                  <div className="training-run-placeholder">
                    No trained Versions yet. A successful run will appear here.
                  </div>
                </td>
              </tr>
            ) : null}
            {versions.map((version) => {
              const automaticallyPinned =
                currentBinding?.modelArtifactLineageId === version.lineage.id;
              return (
                <tr
                  key={version.lineage.id}
                  onClick={() =>
                    onOpenEntry(
                      version.job
                        ? `job:${version.job.id}`
                        : `version:${version.lineage.id}`
                    )
                  }
                >
                  <td>
                    <button
                      className="labs-version-row-button"
                      type="button"
                      onClick={() =>
                        onOpenEntry(
                          version.job
                            ? `job:${version.job.id}`
                            : `version:${version.lineage.id}`
                        )
                      }
                    >
                      <strong>Version {version.number}</strong>
                      <small>{shortId(version.lineage.id)}</small>
                    </button>
                  </td>
                  <td>
                    <VersionStatusBadge job={version.job} version={version} />
                  </td>
                  <td>{trainingMethodLabel(version.plan?.recipe.method)}</td>
                  <td>
                    {version.taskset ? (
                      <button
                        className="labs-version-dataset-link"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenDataset(version.taskset!.id);
                        }}
                      >
                        {version.taskset.name}
                      </button>
                    ) : (
                      "Unavailable"
                    )}
                  </td>
                  <td>
                    <VersionEvalBadge job={version.job} version={version} />
                  </td>
                  <td>{formatDateTime(version.lineage.importedAt)}</td>
                  <td>
                    <div className="training-table-actions">
                      <button
                        aria-pressed={
                          version.lineage.pinned || automaticallyPinned
                        }
                        className="labs-version-icon-button"
                        disabled={readOnly || automaticallyPinned}
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
                            !resolveModelBindingEligibility(version.lineage)
                          }
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void setCurrent(version.lineage.id);
                          }}
                        >
                          Set as default
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

function runBasedOn(
  run: ModelRun | null,
  entries: ModelComparisonSeriesEntry[],
  job: TrainingJob | null,
): string {
  const reference = run?.comparisonSeriesEntry ?? null;
  const entry = reference
    ? entries.find((candidate) => candidate.id === reference.entryId) ?? null
    : null;
  if (!entry) {
    if (typeof job?.metadata.parentHostedArtifactId === "string") {
      return "Prior hosted run";
    }
    return run?.kind === "evaluation" ? "Evaluated Model Version" : "Frozen base";
  }
  if (entry.parent.kind === "base_model") return "Frozen base";
  const parent = entries.find(
    (candidate) =>
      candidate.seriesId === entry.seriesId
      && candidate.modelVersionId === entry.parent.id,
  ) ?? null;
  return parent ? `${parent.label} · Model Version` : "Prior Model Version";
}

export function modelVersionEntries(
  jobs: TrainingJob[],
  versions: LabModelVersion[],
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
  }));
  const knownJobIds = new Set(jobs.map((job) => job.id));
  for (const version of versions) {
    if (version.job && knownJobIds.has(version.job.id)) continue;
    entries.push({
      key: `version:${version.lineage.id}`,
      job: version.job,
      version,
    });
  }
  return entries.sort((left, right) =>
    entryTimestamp(right).localeCompare(entryTimestamp(left))
  );
}

export function modelRunEntries(
  jobs: TrainingJob[],
  versions: LabModelVersion[],
  lifecycleRuns: ModelRun[],
): RunEntry[] {
  const jobByLifecycleRunId = new Map(
    jobs.flatMap((job) =>
      typeof job.metadata.modelRunId === "string"
        ? [[job.metadata.modelRunId, job] as const]
        : []
    )
  );
  const versionByJobId = new Map(
    versions.flatMap((version) =>
      version.job ? [[version.job.id, version] as const] : []
    )
  );
  const versionByLineageId = new Map(
    versions.map((version) => [version.lineage.id, version] as const)
  );
  const matchedJobIds = new Set<string>();
  const entries: RunEntry[] = lifecycleRuns.map((lifecycleRun) => {
    const job =
      jobByLifecycleRunId.get(lifecycleRun.id) ??
      jobs.find((candidate) => candidate.id === lifecycleRun.id) ??
      null;
    if (job) matchedJobIds.add(job.id);
    return {
      key: `model-run:${lifecycleRun.id}`,
      job,
      lifecycleRun,
      version:
        (job ? versionByJobId.get(job.id) ?? null : null) ??
        (lifecycleRun.adapterArtifactLineageId
          ? versionByLineageId.get(lifecycleRun.adapterArtifactLineageId) ??
            null
          : null),
    };
  });
  for (const job of jobs) {
    if (matchedJobIds.has(job.id)) continue;
    entries.push({
      key: `job:${job.id}`,
      job,
      lifecycleRun: null,
      version: versionByJobId.get(job.id) ?? null,
    });
  }
  return entries.sort((left, right) =>
    runEntryTimestamp(right).localeCompare(runEntryTimestamp(left))
  );
}

export function modelRunEntriesForMode(
  entries: RunEntry[],
  mode: "training" | "evals",
): RunEntry[] {
  return entries.filter((entry) =>
    mode === "evals"
      ? entry.lifecycleRun?.kind === "evaluation"
      : entry.lifecycleRun?.kind !== "evaluation",
  );
}

function entryTimestamp(entry: VersionEntry): string {
  return (
    entry.version?.lineage.importedAt ??
    entry.job?.updatedAt ??
    entry.job?.createdAt ??
    ""
  );
}

function runEntryTimestamp(entry: RunEntry): string {
  return (
    entry.lifecycleRun?.updatedAt ??
    entry.job?.updatedAt ??
    entry.job?.createdAt ??
    ""
  );
}

function runResult(entry: RunEntry) {
  if (entry.version) return `Version ${entry.version.number}`;
  if (
    entry.lifecycleRun?.kind === "evaluation"
    && entry.lifecycleRun.receipt?.schemaVersion
      === "openpond.modelEvaluationReceipt.v1"
  ) {
    const delta = entry.lifecycleRun.receipt.foregroundTokenDelta;
    const prefix = delta > 0 ? "+" : "";
    return `${prefix}${delta.toLocaleString()} tokens`;
  }
  if (entry.lifecycleRun?.reward) {
    return `Reward ${entry.lifecycleRun.reward.raw.toFixed(3)}`;
  }
  if (
    entry.lifecycleRun?.status === "failed" ||
    entry.job?.status === "failed"
  ) {
    return "Failed";
  }
  if (
    entry.lifecycleRun?.status === "succeeded" ||
    entry.job?.status === "succeeded"
  ) {
    return "Completed";
  }
  if (
    entry.lifecycleRun?.status === "cancelled" ||
    entry.job?.status === "cancelled"
  ) {
    return "Cancelled";
  }
  return "No output";
}

function hostedTrainingMethod(job: TrainingJob | null): TrainingMethod | null {
  const method = job?.metadata.trainingMethod;
  return method === "sft" || method === "dpo" || method === "grpo" ||
    method === "ppo" || method === "sdft" || method === "opd" ||
    method === "opsd" || method === "sdpo"
    ? method
    : null;
}

function runDuration(entry: RunEntry, now: number): string {
  const status = resolveRunStatus(entry);
  const startedAt =
    entry.lifecycleRun?.startedAt ??
    entry.job?.startedAt ??
    entry.job?.createdAt ??
    null;
  const completedAt = entry.lifecycleRun
    ? terminalRunEnd(
        entry.lifecycleRun.status,
        entry.lifecycleRun.completedAt,
        entry.lifecycleRun.updatedAt,
      )
    : entry.job
      ? terminalRunEnd(
          entry.job.status,
          entry.job.completedAt,
          entry.job.updatedAt,
        )
      : null;
  if (!isActiveRunStatus(status)) return formatDuration(startedAt, completedAt);
  return formatDuration(startedAt, new Date(now).toISOString());
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
      Boolean(version.lineage.managedServing?.customerBindingAllowed)
    : false;
  const evaluationPassed = version
    ? Boolean(resolveModelBindingPromotionGate(version.lineage)) ||
      managedAdapterCustomerBindingAllowed(version.lineage)
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

function shortId(value: string) {
  const normalized = value
    .replace(/^baseline_run_/, "")
    .replace(/^(?:training_job_|lineage_)(?:artifact_)?/, "")
    .replace(/^model_run_/, "");
  return normalized.length <= 12 ? normalized : normalized.slice(-8);
}
