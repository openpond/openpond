import { useMemo } from "react";
import type {
  CreateImproveRun,
  ModelRunDraft,
  TrainingJob,
} from "@openpond/contracts";
import {
  managedAdapterCustomerBindingAllowed,
  resolveModelBindingPromotionGate,
} from "@openpond/contracts";

import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import { Download, Pin } from "../icons";
import { DetailSection } from "../training/DetailSection";
import {
  formatDateTime,
  statusLabel,
  trainingMethodLabel,
} from "../training/training-model-data";
import { LabStatusBadge } from "./LabStatusBadge";
import {
  currentModelBinding,
  labBaseModelVersion,
  labLifecycleModelRuns,
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
  draft: ModelRunDraft | null;
};

export type ModelWorkspaceProps = {
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
        state?.modelRunDrafts.filter(
          (draft) =>
            draft.modelId === workproduct.id &&
            (draft.status === "draft" || draft.status === "ready_to_run")
        ) ?? []
      ),
    [jobs, state?.modelRunDrafts, versions, workproduct.id]
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
              const draft = entry.draft;
              const plan =
                entry.version?.plan ??
                (entry.job ? planById.get(entry.job.planId) ?? null : null);
              const dataset =
                entry.version?.taskset ??
                tasksets.find(
                  (taskset) =>
                    taskset.id ===
                    (draft?.tasksetRef?.id ?? plan?.tasksetId)
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
                            entry.job?.id ?? entry.key
                        )}
                      </small>
                    </button>
                  </td>
                  <td>
                    {draft?.method
                      ? trainingMethodLabel(draft.method)
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
                          : entry.job
                          ? statusLabel(entry.job.status)
                          : "Imported"
                      }
                      value={
                        draft?.status ??
                        entry.job?.status ??
                        "completed"
                      }
                    />
                  </td>
                  <td>
                    {draft ? (
                      "—"
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

export function modelVersionEntries(
  jobs: TrainingJob[],
  versions: LabModelVersion[],
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
    draft: null,
  }));
  const knownJobIds = new Set(jobs.map((job) => job.id));
  for (const version of versions) {
    if (version.job && knownJobIds.has(version.job.id)) continue;
    entries.push({
      key: `version:${version.lineage.id}`,
      job: version.job,
      version,
      draft: null,
    });
  }
  for (const draft of drafts) {
    entries.push({
      key: `draft:${draft.id}`,
      job: null,
      version: null,
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
    entry.job?.updatedAt ??
    entry.job?.createdAt ??
    ""
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
