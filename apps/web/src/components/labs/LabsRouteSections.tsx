import type {
  CreateImproveRun,
  ModelRun,
  TaskCreationSnapshot,
  TrainingStateResponse,
} from "@openpond/contracts";
import type {
  HostedModelProjectCatalog,
  HostedModelProjectLocalState,
} from "../../hooks/hosted-model-project-types";

import type { TrainingWorkspaceProps } from "../training/training-workspace-types";
import { TrainingSuggestions } from "../training/TrainingSuggestions";
import { statusLabel } from "../training/training-model-data";
import {
  ChartColumnStacked,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  DownloadCloud,
  Loader2,
  XCircle,
} from "../icons";
import { workproductKey, type LabWorkproductSummary } from "./lab-workproducts";
import { LabStatusBadge } from "./LabStatusBadge";
import { benchmarkTaskEfficiency } from "./benchmark-attempt-usage";
import {
  labLifecycleModelRuns,
  labModelJobs,
  labModelVersions,
} from "./lab-models";
import { modelRunEntries } from "./LabModelWorkspace";
import { type LabWorkproductProgression } from "./lab-workproduct-progression";
import type { LabsRouteProps } from "./LabsRoute";

const PAGE_SIZE = 10;
const EMPTY_TIMESTAMP = new Date(0).toISOString();

export type ModelTableRow = {
  key: string;
  local: LabWorkproductSummary | null;
  hosted: HostedModelProjectCatalog["projects"][number] | null;
  updatedAt: string;
};
export function SuggestionsTab({
  training,
  onPlanStarted,
}: {
  training: LabsRouteProps["training"];
  onPlanStarted: () => void;
}) {
  return (
    <section className="labs-suggestions-page" aria-label="Suggestions">
      <div className="labs-suggestions-body">
        <TrainingSuggestions
          training={training.training}
          defaultModel={training.defaultModel}
          preferences={training.preferences}
          reasoningEffort={training.reasoningEffort}
          onPlanStarted={onPlanStarted}
        />
      </div>
    </section>
  );
}

export function computeProfileAgentRunSyncKey(runs: CreateImproveRun[]): string {
  return runs
    .filter((run) =>
      run.target.kind === "agent"
      && ["ready_local", "released", "published_hosted"].includes(run.state)
    )
    .map((run) => `${run.id}:${run.revision}:${run.state}`)
    .sort()
    .join("|");
}

export function WorkproductsTable({
  items,
  loading,
  progressionByKey,
  showType,
  onSelect,
  onUseAgent,
  onUseModel,
  onUseSkill,
}: {
  items: LabWorkproductSummary[];
  loading: boolean;
  progressionByKey: Map<string, LabWorkproductProgression>;
  showType: boolean;
  onSelect: (key: string) => void;
  onUseAgent: (actionId: string, agentName: string) => void;
  onUseModel: (tasksetId: string) => void;
  onUseSkill: (skill: LabWorkproductSummary) => void;
}) {
  if (loading)
    return (
      <div className="labs-table-empty">
        <Loader2 className="spin" size={16} /> Loading workproducts…
      </div>
    );
  if (!items.length)
    return (
      <div className="labs-table-empty">No workproducts match this view.</div>
    );
  return (
    <div className="training-table-wrap">
      <table
        className={`training-data-table labs-workproducts-table${
          showType ? "" : " models-only"
        }`}
      >
        <thead>
          <tr>
            {showType ? <th>Type</th> : null}
            <th>Name</th>
            <th>Status</th>
            <th>Training</th>
            <th>Evals</th>
            <th>Updated</th>
            <th>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const progression = progressionByKey.get(item.key);
            return (
              <tr key={item.key} onClick={() => onSelect(item.key)}>
                {showType ? (
                  <td className="labs-workproduct-type">
                    {titleCase(item.kind)}
                  </td>
                ) : null}
                <td>
                  <button
                    className="labs-workproduct-link"
                    type="button"
                    onClick={() => onSelect(item.key)}
                  >
                    <strong>{item.name}</strong>
                    <span>{item.description}</span>
                  </button>
                </td>
                <td>
                  <LabStatusBadge
                    label={progression?.statusLabel ?? item.status}
                    value={progression?.statusValue ?? item.status}
                  />
                </td>
                <td className="labs-workproduct-training">
                  {workproductTraining(item)}
                </td>
                <td className="labs-workproduct-evals">
                  {workproductEvals(item)}
                </td>
                <td className="labs-workproduct-updated">
                  {item.updatedAt === EMPTY_TIMESTAMP
                    ? "—"
                    : compactUpdatedAt(item.updatedAt)}
                </td>
                <td>
                  <div className="labs-workproduct-actions">
                    {item.kind === "skill" ? (
                      <button
                        className="training-button secondary labs-compact-button labs-workproduct-use"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onUseSkill(item);
                        }}
                      >
                        Use
                      </button>
                    ) : item.kind === "agent" && item.useActionId ? (
                      <button
                        className="training-button secondary labs-compact-button labs-workproduct-use"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onUseAgent(item.useActionId!, item.name);
                        }}
                      >
                        Use
                      </button>
                    ) : item.kind === "model" && item.enabled !== null ? (
                      <button
                        className="training-button secondary labs-compact-button labs-workproduct-use"
                        type="button"
                        disabled={!item.enabled}
                        title={
                          item.enabled
                            ? "Start a bounded chat session with this model"
                            : "Chat is available after a version passes frozen evaluation"
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          onUseModel(item.id);
                        }}
                      >
                        Chat
                      </button>
                    ) : null}
                    <ChevronRight size={15} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ModelsTable({
  rows,
  loading,
  busyAction,
  runs,
  state,
  emptyMessage = "No Models yet.",
  onPull,
  onSelect,
  onUseModel,
  onConfigure,
}: {
  rows: ModelTableRow[];
  loading: boolean;
  busyAction: string | null;
  runs: CreateImproveRun[];
  state: TrainingStateResponse | null;
  emptyMessage?: string;
  onPull: (item: HostedModelProjectCatalog["projects"][number]) => void;
  onSelect: (key: string) => void;
  onUseModel: (modelId: string) => void;
  onConfigure: (modelId: string) => void;
}) {
  if (loading) {
    return (
      <div className="labs-table-empty">
        <Loader2 className="spin" size={16} /> Loading Models…
      </div>
    );
  }
  if (!rows.length) {
    return <div className="labs-table-empty">{emptyMessage}</div>;
  }
  return (
    <div className="training-table-wrap">
      <table className="training-data-table labs-models-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Availability</th>
            <th>Recent run</th>
            <th>Updated</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const item = row.local;
            const hosted = row.hosted;
            const versions = item ? labModelVersions(item, runs, state) : [];
            const current = versions.find((version) => version.current) ?? null;
            const runEntries = item
              ? modelRunEntries(
                  labModelJobs(item, runs, state),
                  versions,
                  labLifecycleModelRuns(item, state),
                )
              : [];
            const recentRun = runEntries[0] ?? null;
            const recentRunStatus =
              recentRun?.lifecycleRun?.status ??
              recentRun?.job?.status ??
              "not_run";
            const pulling = hosted
              ? busyAction === `pull-hosted-model-project:${hosted.project.id}`
              : false;
            const pullable = hosted
              ? hosted.localState === "not_pulled" ||
                hosted.localState === "remote_ahead"
              : false;
            const name = item?.name ?? hosted!.project.name;
            const description =
              item?.description ?? hosted!.project.objective ?? "No description";
            return (
              <tr
                key={row.key}
                className={item ? undefined : "labs-hosted-only-row"}
                onClick={item ? () => onSelect(item.key) : undefined}
              >
                <td>
                  {item ? (
                    <button
                      className="labs-workproduct-link"
                      type="button"
                      onClick={() => onSelect(item.key)}
                    >
                      <strong>{name}</strong>
                      <span>{description}</span>
                    </button>
                  ) : (
                    <div className="labs-workproduct-link labs-hosted-project-identity">
                      <strong>{name}</strong>
                      <span>{description}</span>
                      <small>{hosted!.project.portableProjectId}</small>
                    </div>
                  )}
                </td>
                <td>
                  <div className="labs-model-table-summary">
                    {hosted ? (
                      <LabStatusBadge
                        label={hostedLocalStateLabel(hosted.localState)}
                        value={hostedLocalStateTone(hosted.localState)}
                      />
                    ) : (
                      <LabStatusBadge
                        label={current ? "Hosted" : "Local only"}
                        value={current ? "ready" : "not_run"}
                      />
                    )}
                    <span>
                      {hosted
                        ? hosted.project.trainingSetup.baseModel?.modelId ??
                          hosted.project.defaultBaseModel?.modelId ??
                          "No base model"
                        : current
                        ? `Release ${current.number}`
                        : "No active release"}
                    </span>
                  </div>
                </td>
                <td>
                  <div className="labs-model-table-summary">
                    {item ? (
                      <LabStatusBadge
                        label={statusLabel(recentRunStatus)}
                        value={recentRunStatus}
                      />
                    ) : (
                      <LabStatusBadge
                        label={hosted!.project.trainingSetup.method?.toUpperCase() ?? "Configured"}
                        value="prepared"
                      />
                    )}
                    <span>
                      {item
                        ? recentModelRunLabel(
                            recentRun?.lifecycleRun ?? null,
                            runEntries.length,
                          )
                        : `Hosted source r${hosted!.project.sourceRevision}`}
                    </span>
                  </div>
                </td>
                <td>{compactUpdatedAt(row.updatedAt)}</td>
                <td>
                  <div className="labs-workproduct-actions">
                    {hosted && pullable ? (
                      <button
                        className="training-button secondary labs-compact-button"
                        disabled={pulling}
                        title={hostedPullTitle(hosted.localState)}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onPull(hosted);
                        }}
                      >
                        {pulling ? (
                          <Loader2 className="spin" size={13} />
                        ) : (
                          <DownloadCloud size={13} />
                        )}
                        {pulling
                          ? "Importing…"
                          : hosted.localState === "remote_ahead"
                            ? "Update"
                            : "Pull"}
                      </button>
                    ) : item ? (
                      <button
                        className="training-button secondary labs-compact-button labs-workproduct-use"
                        disabled={!current}
                        title={
                          current
                            ? "Chat with the active Version"
                            : hosted
                              ? hostedPullTitle(hosted.localState)
                              : "Set a passing Version active before Chat"
                        }
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onUseModel(item.id);
                        }}
                      >
                        Chat
                      </button>
                    ) : null}
                    {item ? <><button type="button" className="training-button secondary labs-compact-button" onClick={(event) => { event.stopPropagation(); onConfigure(item.id); }}>Configure</button><ChevronRight size={15} /></> : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function hostedLocalStateLabel(state: HostedModelProjectLocalState): string {
  if (state === "not_pulled") return "Hosted only";
  if (state === "up_to_date") return "Local + hosted";
  if (state === "remote_ahead") return "Update available";
  if (state === "local_ahead") return "Local changes";
  if (state === "diverged") return "Diverged";
  return "Local conflict";
}

function hostedLocalStateTone(state: HostedModelProjectLocalState): string {
  if (state === "up_to_date") return "ready";
  if (state === "not_pulled" || state === "remote_ahead") return "prepared";
  if (state === "local_ahead") return "running";
  return "failed";
}

function hostedPullTitle(state: HostedModelProjectLocalState): string {
  if (state === "not_pulled") return "Pull this hosted project locally";
  if (state === "remote_ahead") return "Update the clean local copy from hosted";
  if (state === "up_to_date") return "This project is current locally";
  if (state === "local_ahead") return "Sync local changes before pulling";
  return "Resolve the local and hosted project conflict before pulling";
}

function recentModelRunLabel(run: ModelRun | null, runCount: number): string {
  if (run?.kind === "evaluation") {
    const benchmark = run.evaluation?.benchmarkId === "harness-refiner"
      ? "Harness Refiner 08112026"
      : "Benchmark";
    const outcome = run.receipt?.schemaVersion === "openpond.modelEvaluationReceipt.v1"
      ? run.receipt.attempts?.length
        ? (() => {
            const efficiency = benchmarkTaskEfficiency(run.receipt);
            return `${efficiency.passedTaskCount}/${efficiency.comparedTaskCount} passed`;
          })()
        : titleCase(run.receipt.terminalClassification.replaceAll("_", " "))
      : run.receipt?.schemaVersion === "openpond.modelEvaluationStopReceipt.v1"
        ? "Inconclusive"
      : run.evaluationProgress
        ? `${titleCase(run.evaluationProgress.stage)} ${run.evaluationProgress.completedAttempts}/${run.evaluationProgress.totalAttempts}`
        : statusLabel(run.status);
    return `${benchmark} · ${outcome}`;
  }
  return `${runCount} ${runCount === 1 ? "run" : "runs"}`;
}

function workproductTraining(item: LabWorkproductSummary) {
  if (item.kind !== "model") {
    return (
      <span className="labs-workproduct-na" title="Training not applicable">
        —
      </span>
    );
  }
  const label = `${item.trainingRunCount} training ${
    item.trainingRunCount === 1 ? "run" : "runs"
  }`;
  return (
    <span
      className={`labs-workproduct-indicator${
        item.trainingRunCount > 0 ? " active" : ""
      }`}
      title={label}
    >
      <ChartColumnStacked aria-hidden="true" size={15} />
      <strong aria-hidden="true">{item.trainingRunCount}</strong>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function workproductEvals(item: LabWorkproductSummary) {
  const presentation =
    item.evaluationStatus === "passed"
      ? {
          icon: <CheckCircle2 aria-hidden="true" size={16} />,
          label: "Evals passed",
          tone: "positive",
        }
      : item.evaluationStatus === "failed"
      ? {
          icon: <XCircle aria-hidden="true" size={16} />,
          label: "Evals failed",
          tone: "negative",
        }
      : {
          icon: <CircleDashed aria-hidden="true" size={16} />,
          label: "Evals not run",
          tone: "neutral",
        };
  return (
    <span
      className={`labs-workproduct-indicator ${presentation.tone}`}
      title={presentation.label}
    >
      {presentation.icon}
      <span className="sr-only">{presentation.label}</span>
    </span>
  );
}

function compactUpdatedAt(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "2-digit" }),
  }).format(date);
}

export function Pagination({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;
  return (
    <nav className="labs-pagination" aria-label="Pagination">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        Previous
      </button>
      <span>
        {page} of {pages}
      </span>
      <button
        type="button"
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
      >
        Next
      </button>
    </nav>
  );
}

export async function finishModelCreation(
  creation: TaskCreationSnapshot,
  training: LabsRouteProps["training"],
  refreshRuns: () => Promise<CreateImproveRun[] | null>,
  setSelectedKey: (key: string | null) => void
) {
  training.onLaunchHandled(training.launchRequest?.id ?? 0);
  if (!creation.materializedTasksetId) return;
  training.onSelectedTasksetIdChange(creation.materializedTasksetId);
  training.onDetailTasksetIdChange(creation.materializedTasksetId);
  const refreshed = await refreshRuns();
  const run = refreshed?.find(
    (candidate) => candidate.id === creation.request.createImproveRunId
  );
  setSelectedKey(
    workproductKey(
      "model",
      run?.target.kind === "model"
        ? run.target.id ?? run.id
        : creation.materializedTasksetId
    )
  );
}

export function creationObjective(
  creation: TaskCreationSnapshot,
  fallback: string
): string {
  return (
    creation.request.objective?.trim() ||
    creation.proposal?.objective.trim() ||
    creation.proposal?.name.trim() ||
    fallback
  );
}

function titleCase(value: string): string {
  return value
    ? `${value[0]!.toUpperCase()}${value.slice(1).replaceAll("_", " ")}`
    : value;
}

export function trainingModelRunSyncKey(
  training: TrainingWorkspaceProps["training"]["payload"]
): string {
  if (!training) return "";
  return [
    ...training.jobs.map((job) => `job:${job.id}:${job.status}`),
    ...training.models.map(
      (model) =>
        `model:${model.id}:${model.status}:${model.artifactId}:${model.jobId}`
    ),
  ]
    .sort()
    .join("|");
}
