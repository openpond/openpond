import { useEffect, useMemo, useState } from "react";
import type {
  CreateImproveRun,
  ModelRunDraft,
  TasksetBaselineRun,
  TrainingJob,
  TrainingJobEvent,
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
}: ModelWorkspaceProps & {
  onOpenEntry: (entryKey: string) => void;
  onResumeDraft: (draftId: string) => void;
  onToast: ShowAppToast;
}) {
  const state = training.payload;
  const jobs = useMemo(() => labModelJobs(workproduct, runs, state), [runs, state, workproduct]);
  const versions = useMemo(
    () => labModelVersions(workproduct, runs, state),
    [runs, state, workproduct],
  );
  const baselineRuns = useMemo(
    () => labModelBaselineRuns(workproduct, runs, state),
    [runs, state, workproduct],
  );
  const plans = useMemo(() => labModelPlans(workproduct, runs, state), [runs, state, workproduct]);
  const planById = useMemo(() => new Map(plans.map((plan) => [plan.id, plan] as const)), [plans]);
  const entries = useMemo(
    () =>
      modelVersionEntries(
        jobs,
        versions,
        baselineRuns,
        state?.modelRunDrafts.filter(
          (draft) =>
            draft.modelId === workproduct.id &&
            (draft.status === "draft" || draft.status === "ready_to_run"),
        ) ?? [],
      ),
    [baselineRuns, jobs, state?.modelRunDrafts, versions, workproduct.id],
  );
  const currentBinding = currentModelBinding(workproduct, runs, state);

  async function setCurrent(versionId: string) {
    const version = versions.find((candidate) => candidate.lineage.id === versionId);
    if (!version?.lineage.promotable) return;
    if (!window.confirm(`Set Version ${version.number} as active for ${workproduct.name}?`)) {
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
    <section className="labs-model-version-index" aria-label="Runs">
      <div className="training-table-wrap">
        <table className="training-data-table labs-model-versions-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Training</th>
              <th>Dataset</th>
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
            {!entries.length ? (
              <tr>
                <td colSpan={8}>
                  <div className="training-run-placeholder">
                    No runs yet. Complete the build setup and start the first run.
                  </div>
                </td>
              </tr>
            ) : null}
            {entries.map((entry) => {
              const baselineRun = entry.baselineRun;
              const draft = entry.draft;
              const plan =
                entry.version?.plan ?? (entry.job ? planById.get(entry.job.planId) ?? null : null);
              const dataset =
                entry.version?.taskset ??
                state?.tasksets.find(
                  (taskset) =>
                    taskset.id ===
                    (draft?.tasksetRef?.id ?? baselineRun?.tasksetId ?? plan?.tasksetId),
                ) ??
                null;
              const version = entry.version;
              const automaticallyPinned =
                version && currentBinding?.modelArtifactLineageId === version.lineage.id;

              return (
                <tr
                  key={entry.key}
                  onClick={() => (draft ? onResumeDraft(draft.id) : onOpenEntry(entry.key))}
                >
                  <td>
                    <button
                      className="labs-version-row-button"
                      type="button"
                      onClick={() =>
                        draft ? onResumeDraft(draft.id) : onOpenEntry(entry.key)
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
                            entry.key,
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
                      value={draft?.status ?? baselineRun?.status ?? entry.job?.status ?? "completed"}
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
                    {draft ? "—" : <VersionStatusBadge job={entry.job} version={version} />}
                  </td>
                  <td>
                    {formatDateTime(
                      draft?.updatedAt ??
                        version?.lineage.importedAt ??
                        baselineRun?.updatedAt ??
                        entry.job?.updatedAt ??
                        "",
                    )}
                  </td>
                  <td>
                    {draft ? (
                      <button
                        className="training-button secondary"
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
                          void training.actions.cancelBaselineRun(baselineRun.id);
                        }}
                      >
                        Cancel
                      </button>
                    ) : version ? (
                      <div className="training-table-actions">
                        <button
                          aria-pressed={version.lineage.pinned || Boolean(automaticallyPinned)}
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
                            void togglePinned(version.lineage.id, !version.lineage.pinned);
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
                            void training.actions.downloadModelPackage(version.lineage.id);
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
}: ModelWorkspaceProps & {
  connection: ClientConnection | null;
  selectedEntryKey: string;
  onBack: () => void;
  onTabChange?: (tab: "summary" | "metrics" | "evals" | "artifacts" | "logs") => void;
  onUseVersion: (versionId: string) => void;
}) {
  const [activeRunTab, setActiveRunTab] = useState<
    "summary" | "metrics" | "evals" | "artifacts" | "logs"
  >("summary");
  const state = training.payload;
  const jobs = useMemo(() => labModelJobs(workproduct, runs, state), [runs, state, workproduct]);
  const versions = useMemo(
    () => labModelVersions(workproduct, runs, state),
    [runs, state, workproduct],
  );
  const baselineRuns = useMemo(
    () => labModelBaselineRuns(workproduct, runs, state),
    [runs, state, workproduct],
  );
  const plans = useMemo(() => labModelPlans(workproduct, runs, state), [runs, state, workproduct]);
  const planById = useMemo(() => new Map(plans.map((plan) => [plan.id, plan] as const)), [plans]);
  const entries = useMemo(
    () => modelVersionEntries(jobs, versions, baselineRuns),
    [baselineRuns, jobs, versions],
  );
  const selected = entries.find((entry) => entry.key === selectedEntryKey) ?? null;
  const selectedJob = selected?.job ?? null;
  const selectedVersion = selected?.version ?? null;
  const selectedBaselineRun = selected?.baselineRun ?? null;
  const selectedPlan =
    selectedVersion?.plan ?? (selectedJob ? planById.get(selectedJob.planId) ?? null : null);
  const selectedTaskset =
    selectedVersion?.taskset ??
    state?.tasksets.find(
      (taskset) => taskset.id === (selectedBaselineRun?.tasksetId ?? selectedPlan?.tasksetId),
    ) ??
    null;
  const detail = useTrainingRunDetail(
    connection,
    selectedJob?.id ?? null,
    selectedJob?.status ?? null,
  );
  const receipts = selectedJob
    ? state?.rolloutReceipts.filter((receipt) => receipt.jobId === selectedJob.id) ?? []
    : [];
  useEffect(() => {
    setActiveRunTab("summary");
    onTabChange?.("summary");
  }, [onTabChange, selectedEntryKey]);

  if (!selected) {
    return (
      <div className="labs-model-version-detail">
        <button className="settings-secondary compact" type="button" onClick={onBack}>
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

      <div className="training-detail-tabs" role="tablist" aria-label="Run detail">
        {([
          ["summary", "Summary"],
          ["metrics", "Metrics"],
          ["evals", "Evals"],
          ["artifacts", "Artifacts"],
          ["logs", "Logs"],
        ] as const).map(([id, label]) => (
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

      {activeRunTab === "summary" ? <DetailSection
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
              onClick={() => void training.actions.cancelBaselineRun(selectedBaselineRun.id)}
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
                  void training.actions.downloadModelPackage(selectedVersion.lineage.id)
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
              selectedVersion ? (selectedVersion.current ? "Active" : "Available") : "Not created"
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
          <Fact label="Dataset" value={selectedTaskset?.name ?? "Unavailable"} />
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
                ? formatDuration(selectedBaselineRun.startedAt, selectedBaselineRun.completedAt)
                : selectedJob
                ? formatDuration(selectedJob.startedAt, selectedJob.completedAt)
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
          <p className="labs-training-error">{selectedBaselineRun?.error ?? selectedJob?.error}</p>
        ) : null}
      </DetailSection> : null}

      {selectedJob && activeRunTab === "metrics" ? (
        <>
          <DetailSection
            title={selectedPlan?.recipe.method === "grpo" ? "Rollout scores" : "Training metrics"}
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
        <DetailSection title="Evaluation">
          <TrainingRunEvaluation detail={detail.detail} loading={detail.loading} />
        </DetailSection>
      ) : null}

      {activeRunTab === "artifacts" ? <DetailSection title="Configuration and artifacts">
        <dl className="training-configuration-list">
          <Fact
            label={selectedBaselineRun ? "Check run" : "Training attempt"}
            value={selectedBaselineRun?.id ?? selectedJob?.id ?? "Provider import"}
          />
          <Fact label="Dataset" value={selectedTaskset?.name ?? "Unavailable"} />
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
            <Fact label="Provider status" value={selectedBaselineRun.provider.statusCode} />
          ) : null}
        </dl>
      </DetailSection> : null}

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

function modelVersionEntries(
  jobs: TrainingJob[],
  versions: LabModelVersion[],
  baselineRuns: TasksetBaselineRun[],
  drafts: ModelRunDraft[] = [],
): VersionEntry[] {
  const versionByJobId = new Map(
    versions.flatMap((version) => (version.job ? [[version.job.id, version] as const] : [])),
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
  return entries.sort((left, right) => entryTimestamp(right).localeCompare(entryTimestamp(left)));
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
      value={run.reportId ? "passed" : isActiveBaselineRun(run) ? "running" : run.status}
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
    ? job?.metadata.frozenEvaluationComplete === true
      || Boolean(version.lineage.frozenEvaluationArtifactId)
    : false;
  const evaluationPassed = version
    ? typeof job?.metadata.frozenEvaluationThresholdPassed === "boolean"
      ? job.metadata.frozenEvaluationThresholdPassed
      : version.lineage.promotable
    : false;
  const label = version
    ? !evaluationComplete
      ? "Not run"
      : evaluationPassed
        ? "Passed"
        : "Failed"
    : job && ["queued", "starting", "running", "cancelling", "reconciling"].includes(job.status)
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
    job && ["queued", "starting", "running", "cancelling", "reconciling"].includes(job.status),
  );
  return (
    <LabStatusBadge
      label={version ? (version.current ? "Active" : "Available") : pending ? "Pending" : "Not created"}
      value={version ? (version.current ? "current" : "ready") : pending ? "running" : "not_run"}
    />
  );
}

function baseModelName(plan: ReturnType<typeof labModelPlans>[number] | null) {
  if (!plan) return "Not recorded";
  const model = plan.recipe.method === "sft" || plan.recipe.method === "grpo"
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
  return type.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
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
    const kind = typeof payload.metricKind === "string"
      ? payload.metricKind.replaceAll("_", " ")
      : "metric";
    const values = [
      numericSummary("loss", payload.loss),
      numericSummary("reward", payload.meanReward ?? payload.reward),
      numericSummary("policy loss", payload.policyLoss),
      numericSummary("value loss", payload.valueLoss),
      numericSummary("preference accuracy", payload.preferenceAccuracy, percentValue),
    ].filter((value): value is string => Boolean(value));
    return `${kind}${step == null ? "" : ` · step ${step}`}${values.length ? ` · ${values.join(" · ")}` : ""}`;
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
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(number),
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
