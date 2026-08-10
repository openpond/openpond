import { useEffect, useMemo, useState } from "react";
import type {
  ChatModelRef,
  CreateImproveRun,
  Taskset,
  TrainingStateResponse,
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
type DatasetDetailTab = "overview" | "cases" | "scoring" | "history";
const DATASET_DETAIL_TABS: Array<{ id: DatasetDetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "cases", label: "Cases" },
  { id: "scoring", label: "Scoring" },
  { id: "history", label: "History" },
];

export function LabDatasetsPage({
  state,
  runs,
  selectedId,
  onSelectedIdChange,
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
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return tasksets;
    return tasksets.filter((taskset) =>
      [taskset.name, taskset.objective, taskset.id]
        .some((value) => value.toLowerCase().includes(normalized)));
  }, [query, tasksets]);
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const modelCountByDataset = useMemo(() => {
    const counts = new Map<string, number>();
    if (!state) return counts;
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
  }, [runs, state]);

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
                onClick={() => setDetailTab("scoring")}
              >
                Run Benchmark
              </button>
            ) : (
              <button
                className="training-button"
                disabled={readOnly || !selected.readiness?.ready}
                title={readOnly
                  ? "Switch to this Taskset's Profile before launching a Model run."
                  : selected.readiness?.ready
                    ? "Create a Model run from this ready Taskset."
                    : selected.readiness?.blockers[0]?.message ?? "Run Taskset checks before training."}
                type="button"
                onClick={() => onTrainModel(selected.id)}
              >
                Train Model
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
        {detailTab === "history" ? (
          <TasksetHistory state={state} taskset={selected} />
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
            {detailTab === "scoring" &&
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
            {visible.map((taskset) => {
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
              const delta = receipt?.foregroundTokenDelta ?? null;
              return (
                <tr key={run.id}>
                  <td>{modelNames.get(run.modelId) ?? run.modelId}</td>
                  <td>{run.status}</td>
                  <td>
                    {receipt
                      ? `${Math.round(receipt.quality.candidatePassRate * 100)}% candidate`
                      : "Pending"}
                  </td>
                  <td>
                    {delta === null
                      ? "—"
                      : `${delta > 0 ? "+" : ""}${delta.toLocaleString()}`}
                  </td>
                  <td>{run.evaluation?.mode ?? "—"}</td>
                  <td>{formatCompactDate(run.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  if (!runs.length) {
    return (
      <div className="labs-table-empty">
        This Taskset has not been used in a submitted run yet.
      </div>
    );
  }

  return (
    <>
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
