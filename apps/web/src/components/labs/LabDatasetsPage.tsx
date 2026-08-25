import { useEffect, useMemo, useState } from "react";
import type {
  ChatModelRef,
  CreateImproveRun,
  Taskset,
  TasksetDraft,
  TrainingStateResponse,
  TasksetOperationalState,
} from "@openpond/contracts";

import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import { ArrowLeft, Search } from "../icons";
import {
  statusLabel,
  trainingMethodLabel,
} from "../training/training-model-data";
import { LabExpertBootstrap } from "./LabExpertBootstrap";
import { LabModelDataset } from "./LabModelDataset";
import { LabStatusBadge } from "./LabStatusBadge";
import { labModelDatasets } from "./lab-models";
import { labWorkproductProjection } from "./lab-workproducts";

const PAGE_SIZE = 10;
type TasksetListItem =
  | { kind: "draft"; value: TasksetDraft }
  | { kind: "taskset"; value: Taskset };
type DatasetDetailTab =
  | "overview"
  | "scenarios"
  | "runs"
  | "attempts"
  | "review"
  | "metrics"
  | "versions";
const DATASET_DETAIL_TABS: Array<{ id: DatasetDetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "scenarios", label: "Scenarios" },
  { id: "runs", label: "Generate & Runs" },
  { id: "attempts", label: "Attempts" },
  { id: "review", label: "Review" },
  { id: "metrics", label: "Metrics" },
  { id: "versions", label: "Versions" },
];

export function LabDatasetsPage({
  state,
  runs,
  selectedId,
  onSelectedIdChange,
  onOpenDraft,
  defaultModel,
  onImproveInChat,
  onTrainModel,
  onOpenFiles,
  training,
  onToast,
}: {
  state: TrainingStateResponse | null;
  runs: CreateImproveRun[];
  selectedId: string | null;
  onSelectedIdChange: (tasksetId: string | null) => void;
  onOpenDraft: (draftId: string) => void;
  defaultModel: ChatModelRef;
  onImproveInChat: (taskset: Taskset) => void;
  onTrainModel: (tasksetId: string) => void;
  onOpenFiles: (tasksetId: string) => void;
  training: ReturnType<typeof useTraining>;
  onToast: ShowAppToast;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [detailTab, setDetailTab] = useState<DatasetDetailTab>("overview");
  const tasksets = state?.tasksets ?? [];
  const selected =
    [...tasksets, ...(state?.modelTasksets ?? [])].find(
      (taskset) => taskset.id === selectedId,
    ) ?? null;
  const readOnly = Boolean(selected && selected.profileId !== state?.profileId);
  const builtIn = selected?.benchmark?.source === "builtin";
  const selectedArtifact = selected?.datasetArtifact
    ? state?.datasetArtifacts.find(
        (artifact) =>
          artifact.tasksetId === selectedId
          && artifact.tasksetRevision === selected.revision,
      ) ?? null
    : null;
  const filtered = useMemo<TasksetListItem[]>(() => {
    const normalized = query.trim().toLowerCase();
    return [
      ...(state?.tasksetDrafts ?? [])
        .filter((draft) => draft.status !== "published")
        .map((value) => ({ kind: "draft" as const, value })),
      ...tasksets.map((value) => ({ kind: "taskset" as const, value })),
    ]
      .filter(({ value }) => !normalized || [value.name, value.objective, value.id]
        .some((candidate) => candidate.toLowerCase().includes(normalized)))
      .sort((left, right) => right.value.updatedAt.localeCompare(left.value.updatedAt));
  }, [query, state?.tasksetDrafts, tasksets]);
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const modelCountByDataset = useMemo(() => {
    const counts = new Map<string, number>();
    if (!state || tasksets.length === 0) return counts;
    const models = labWorkproductProjection({
      profile: null,
      training: state,
      runs,
    }).filter((workproduct) => workproduct.kind === "model");
    for (const model of models) {
      for (const dataset of labModelDatasets(model, runs, state)) {
        counts.set(dataset.id, (counts.get(dataset.id) ?? 0) + 1);
      }
    }
    return counts;
  }, [runs, state, tasksets]);

  useEffect(() => {
    setDetailTab("overview");
  }, [selectedId]);

  if (selected) {
    return (
      <div className="labs-flat-body labs-datasets-page">
        <div className="labs-dataset-detail-heading">
          <button
            aria-label="Back to Tasksets"
            className="labs-back-button"
            type="button"
            onClick={() => onSelectedIdChange(null)}
          >
            <ArrowLeft size={15} />
          </button>
          <div>
            <h1>{selected.name}</h1>
            <p>{selected.objective}</p>
          </div>
          <div className="labs-dataset-detail-actions">
            {readOnly ? (
              <LabStatusBadge
                label={`Profile: ${selected.profileId}`}
                value="available"
              />
            ) : null}
            {!builtIn ? (
              <button
                className="training-button secondary"
                disabled={readOnly}
                title={
                  readOnly
                    ? "Switch to this Taskset's Profile to modify it."
                    : "Improve this Taskset in Chat."
                }
                type="button"
                onClick={() => onImproveInChat(selected)}
              >
                Improve in Chat
              </button>
            ) : null}
            {selected.purpose === "benchmark" ? (
              <button
                className="training-button"
                disabled={readOnly}
                type="button"
                onClick={() => setDetailTab("runs")}
              >
                Run Benchmark
              </button>
            ) : (
              <button
                className="training-button"
                disabled={readOnly}
                type="button"
                onClick={() => setDetailTab("runs")}
              >
                Create run
              </button>
            )}
            <LabStatusBadge
              label={datasetStatus(selected)}
              value={selected.status}
            />
          </div>
        </div>
        <div
          className="training-detail-tabs"
          role="tablist"
          aria-label="Taskset detail"
        >
          {DATASET_DETAIL_TABS.map((tab) => (
            <button
              aria-selected={detailTab === tab.id}
              className={detailTab === tab.id ? "active" : undefined}
              key={tab.id}
              role="tab"
              type="button"
              onClick={() => setDetailTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {detailTab === "runs" ? (
          <TasksetRuns
            readOnly={readOnly}
            state={state}
            taskset={selected}
            onCreateRun={() => onTrainModel(selected.id)}
          />
        ) : detailTab === "attempts" ? (
          <TasksetAttempts taskset={selected} training={training} />
        ) : detailTab === "versions" ? (
          <TasksetVersions taskset={selected} />
        ) : (
          <>
            <LabModelDataset
              artifact={selectedArtifact}
              defaultModel={defaultModel}
              tab={detailTab}
              taskset={selected}
              onOpenFiles={() => onOpenFiles(selected.id)}
              onToast={onToast}
              training={training}
            />
            {detailTab === "metrics" &&
            selected.metadata.flagship === "cross-system-operations" ? (
              <LabExpertBootstrap
                busyAction={training.busyAction}
                taskset={selected}
                onApprove={(previewHash) =>
                  training.actions.approveExpertBootstrap(
                    selected.id,
                    previewHash,
                  )
                }
                onPreview={() =>
                  training.actions.previewExpertBootstrap(selected.id)
                }
                onToast={onToast}
              />
            ) : null}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="labs-flat-body labs-datasets-page">
      <div className="labs-workproduct-toolbar">
        <label className="labs-search">
          <Search size={14} />
          <input
            aria-label="Search Tasksets"
            placeholder="Search Tasksets"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <button
          className="training-button secondary labs-compact-button"
          disabled={training.loading}
          type="button"
          onClick={() => void training.refresh()}
        >
          {training.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="training-table-wrap">
        <table className="training-data-table labs-datasets-table">
          <thead>
            <tr>
              <th>Taskset</th>
              <th>Training</th>
              <th>Validation</th>
              <th>Frozen Eval</th>
              <th>Graders</th>
              <th>Activity</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => {
              if (item.kind === "draft") {
                const draft = item.value;
                return (
                  <tr key={`draft:${draft.id}`}>
                    <td>
                      <button
                        className="labs-workproduct-link"
                        type="button"
                        onClick={() => onOpenDraft(draft.id)}
                      >
                        <strong>
                          {draft.name || "Untitled Taskset"}
                          <span className="labs-taskset-draft-badge">Draft</span>
                        </strong>
                        <span>{draft.objective || "Empty draft"}</span>
                      </button>
                    </td>
                    <td>{draftSplitCount(draft, "train")}</td>
                    <td>{draftSplitCount(draft, "validation")}</td>
                    <td>{draftSplitCount(draft, "frozen_eval")}</td>
                    <td>{draft.graders.length}</td>
                    <td>Resume draft</td>
                    <td>{formatCompactDate(draft.updatedAt)}</td>
                  </tr>
                );
              }
              const taskset = item.value;
              const modelCount = modelCountByDataset.get(taskset.id) ?? 0;
              const benchmarkRunCount = (state?.benchmarkRuns ?? []).filter(
                (run) => run.metadata.sourceTasksetId === taskset.id,
              ).length;
              return (
                <tr key={taskset.id}>
                  <td>
                    <button
                      className="labs-workproduct-link"
                      type="button"
                      onClick={() => onSelectedIdChange(taskset.id)}
                    >
                      <strong>{taskset.name}</strong>
                      <span>{taskset.objective}</span>
                    </button>
                  </td>
                  <td>{splitCount(taskset, state, "train")}</td>
                  <td>{splitCount(taskset, state, "validation")}</td>
                  <td>{splitCount(taskset, state, "frozen_eval")}</td>
                  <td>{taskset.graders.length}</td>
                  <td>
                    {taskset.purpose === "benchmark"
                      ? benchmarkRunCount
                        ? `${benchmarkRunCount} run${benchmarkRunCount === 1 ? "" : "s"}`
                        : "Not run"
                      : modelCount
                        ? `${modelCount} model${modelCount === 1 ? "" : "s"}`
                        : "—"}
                  </td>
                  <td>{formatCompactDate(taskset.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!visible.length ? <div className="labs-table-empty">No Tasksets match this view.</div> : null}
      <DatasetPagination
        page={page}
        total={filtered.length}
        onChange={setPage}
      />
    </div>
  );
}

function TasksetRuns({
  readOnly,
  state,
  taskset,
  onCreateRun,
}: {
  readOnly: boolean;
  state: TrainingStateResponse | null;
  taskset: Taskset;
  onCreateRun: () => void;
}) {
  return (
    <>
      <section className="labs-dataset-run-intro">
        <h2>Generate attempts or train from this Taskset</h2>
        <p>
          Choose a model and run type in the run builder. Collection, reward-model,
          and policy runs keep their own immutable inputs and receipts.
        </p>
        <button
          className="training-button"
          disabled={readOnly}
          type="button"
          onClick={onCreateRun}
        >
          Create run
        </button>
      </section>
      <TasksetHistory state={state} taskset={taskset} />
    </>
  );
}

function TasksetAttempts({
  taskset,
  training,
}: {
  taskset: Taskset;
  training: ReturnType<typeof useTraining>;
}) {
  const [operations, setOperations] = useState<TasksetOperationalState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void training.actions.tasksetOperationalState(taskset.id)
      .then((next) => {
        if (active) setOperations(next);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [taskset.id, training.actions]);

  if (loading) return <div className="labs-table-empty">Loading Attempts…</div>;
  if (error) return <div className="training-banner error" role="alert">{error}</div>;
  if (!operations?.attempts.length) {
    return <div className="labs-table-empty">No Attempts have been recorded for this Taskset.</div>;
  }
  const artifactsByAttempt = groupCount(operations.artifacts.map((artifact) => artifact.attemptId));
  const gradeByAttempt = new Map(operations.grades.map((grade) => [grade.attemptId, grade]));
  const distinctOutputs = new Set(operations.attempts.map((attempt) => JSON.stringify(attempt.output))).size;
  return (
    <>
    <p className="labs-detail-copy">
      {operations.attempts.length} Attempts · {distinctOutputs} distinct outputs · {operations.artifacts.length} artifacts
    </p>
    <div className="training-table-wrap">
      <table className="training-data-table">
        <thead>
          <tr>
            <th>Attempt</th>
            <th>Scenario</th>
            <th>Status</th>
            <th>Evidence</th>
            <th>Reward</th>
            <th>Artifacts</th>
          </tr>
        </thead>
        <tbody>
          {operations.attempts.map((attempt) => {
            const grade = gradeByAttempt.get(attempt.id);
            return (
              <tr key={attempt.id}>
                <td><code>{attempt.id}</code></td>
                <td>{attempt.taskId}</td>
                <td>{attempt.infrastructureError ? "Infrastructure error" : "Completed"}</td>
                <td>{attemptEvidenceLabel(attempt)}</td>
                <td>{grade?.score == null ? "—" : grade.score.toFixed(3)}</td>
                <td>{artifactsByAttempt.get(attempt.id) ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}

function attemptEvidenceLabel(attempt: TasksetOperationalState["attempts"][number]): string {
  const metadata = attempt.metadata;
  if (metadata.execution === "synthetic_collection_fixture") {
    const label = typeof metadata.fixtureLabel === "string"
      ? metadata.fixtureLabel.replace(/^./, (value) => value.toUpperCase())
      : "Unlabeled";
    const group = typeof metadata.collectionGroupIndex === "number"
      ? `group ${metadata.collectionGroupIndex + 1}`
      : "fixture group";
    return `Fixture · ${group} · ${label}`;
  }
  return attempt.modelRef ? "Model attempt" : "Recorded attempt";
}

function TasksetVersions({ taskset }: { taskset: Taskset }) {
  return (
    <section className="labs-dataset-run-intro">
      <h2>Published version</h2>
      <dl className="labs-inline-facts">
        <div><dt>Revision</dt><dd>{taskset.revision}</dd></div>
        <div><dt>Content hash</dt><dd><code>{taskset.contentHash}</code></dd></div>
        <div><dt>Updated</dt><dd>{formatCompactDate(taskset.updatedAt)}</dd></div>
      </dl>
      <p>Runs pin this immutable revision. Editing starts a new draft and publishes a new version.</p>
    </section>
  );
}

function TasksetHistory({
  state,
  taskset,
}: {
  state: TrainingStateResponse | null;
  taskset: Taskset;
}) {
  const [showAll, setShowAll] = useState(false);
  const runs = (state?.modelRuns ?? [])
    .filter((run) => run.taskset.id === taskset.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const visibleRuns = showAll ? runs : runs.slice(0, 10);
  const rewardRuns = (state?.rewardModelRuns ?? [])
    .filter((run) => run.taskset.id === taskset.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const modelNames = new Map(
    (state?.modelProjects ?? []).map((project) => [project.id, project.name]),
  );
  if (taskset.purpose === "benchmark") {
    const evaluationRuns = runs.filter((run) => run.kind === "evaluation");
    if (!evaluationRuns.length) {
      return (
        <div className="labs-table-empty">
          This benchmark has not been run yet.
        </div>
      );
    }
    return (
      <div className="training-table-wrap">
        <table className="training-data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Status</th>
              <th>Quality</th>
              <th>Token delta</th>
              <th>Mode</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {evaluationRuns.map((run) => {
              const receipt = run.receipt?.schemaVersion
                === "openpond.modelEvaluationReceipt.v1"
                ? run.receipt
                : null;
              const stopReceipt = run.receipt?.schemaVersion
                === "openpond.modelEvaluationStopReceipt.v1"
                ? run.receipt
                : null;
              const delta = receipt?.foregroundTokenDelta ?? null;
              return (
                <tr key={run.id}>
                  <td>{modelNames.get(run.modelId) ?? run.modelId}</td>
                  <td>{stopReceipt ? "inconclusive" : run.status}</td>
                  <td>
                    {receipt
                      ? `${Math.round(receipt.quality.candidatePassRate * 100)}% candidate`
                      : stopReceipt
                        ? "Candidate skipped"
                      : "Pending"}
                  </td>
                  <td>
                    {delta === null
                      ? "—"
                      : `${delta > 0 ? "+" : ""}${delta.toLocaleString()}`}
                  </td>
                  <td>
                    {run.evaluation
                      ? `${run.evaluation.attemptPlan.reduce((sum, stage) => sum + stage.attemptCount, 0)} attempts`
                      : "—"}
                  </td>
                  <td>{formatCompactDate(run.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  if (!runs.length && !rewardRuns.length) {
    return (
      <div className="labs-table-empty">
        This Taskset has not been used in a submitted run yet.
      </div>
    );
  }

  return (
    <>
      {rewardRuns.length ? (
        <div className="training-table-wrap">
          <table className="training-data-table">
            <thead>
              <tr><th>Reward Model Run</th><th>Scope</th><th>Progress</th><th>Loss</th><th>Status</th><th>Spend</th></tr>
            </thead>
            <tbody>
              {rewardRuns.map((run) => (
                <tr key={run.id}>
                  <td>{run.id}</td>
                  <td>{statusLabel(run.scope)}</td>
                  <td>{run.progress.completedSteps}/{run.progress.totalSteps}</td>
                  <td>{run.progress.latestLoss?.toFixed(4) ?? "—"}</td>
                  <td><LabStatusBadge label={statusLabel(run.status)} value={run.status} /></td>
                  <td>{run.accruedSpendUsd == null ? "—" : `$${run.accruedSpendUsd.toFixed(2)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {runs.length ? (
      <div className="training-table-wrap">
        <table className="training-data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Run</th>
              <th>Method</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {visibleRuns.map((run) => (
              <tr key={run.id}>
                <td>{modelNames.get(run.modelId) ?? run.modelId}</td>
                <td>{statusLabel(run.kind)}</td>
                <td>{trainingMethodLabel(run.method)}</td>
                <td>
                  <LabStatusBadge
                    label={statusLabel(run.status)}
                    value={run.status}
                  />
                </td>
                <td>{formatCompactDate(run.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      ) : null}
      {runs.length > 10 ? (
        <div className="labs-model-run-list-actions">
          <button
            className="training-button secondary labs-compact-button"
            type="button"
            onClick={() => setShowAll((visible) => !visible)}
          >
            {showAll ? "Show latest 10" : `Show all ${runs.length} runs`}
          </button>
        </div>
      ) : null}
    </>
  );
}

function splitCount(
  taskset: Taskset,
  state: TrainingStateResponse | null,
  split: Taskset["tasks"][number]["split"],
): number {
  const artifact = taskset.datasetArtifact
    ? state?.datasetArtifacts.find(
        (candidate) =>
          candidate.tasksetId === taskset.id
          && candidate.tasksetRevision === taskset.revision,
      )
    : null;
  if (artifact) return artifact.splitCounts[split] ?? 0;
  return taskset.tasks.filter((task) => task.split === split).length;
}

function draftSplitCount(
  draft: TasksetDraft,
  split: TasksetDraft["tasks"][number]["split"],
): number {
  return draft.tasks.filter((task) => task.split === split).length;
}

function datasetStatus(taskset: Taskset): string {
  if (taskset.readiness?.ready) return "Ready";
  if (taskset.status === "ready") return "Needs Evals";
  return taskset.status.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

function formatCompactDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function groupCount(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function DatasetPagination({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages === 1) return null;
  return (
    <nav className="labs-pagination" aria-label="Taskset pages">
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>Previous</button>
      <span>{page} of {pages}</span>
      <button type="button" disabled={page >= pages} onClick={() => onChange(page + 1)}>Next</button>
    </nav>
  );
}
