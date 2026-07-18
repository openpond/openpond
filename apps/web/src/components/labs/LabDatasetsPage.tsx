import { useMemo, useState } from "react";
import type {
  CreateImproveRun,
  Taskset,
  TrainingStateResponse,
} from "@openpond/contracts";

import { ArrowLeft, Search } from "../icons";
import { LabModelDataset } from "./LabModelDataset";
import { LabStatusBadge } from "./LabStatusBadge";
import { labModelDatasets } from "./lab-models";
import { labWorkproductProjection } from "./lab-workproducts";

const PAGE_SIZE = 10;

export function LabDatasetsPage({
  state,
  runs,
  selectedId,
  onSelectedIdChange,
  onCreate,
  onOpenFiles,
}: {
  state: TrainingStateResponse | null;
  runs: CreateImproveRun[];
  selectedId: string | null;
  onSelectedIdChange: (tasksetId: string | null) => void;
  onCreate: () => void;
  onOpenFiles: (tasksetId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const tasksets = state?.tasksets ?? [];
  const selected = tasksets.find((taskset) => taskset.id === selectedId) ?? null;
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

  if (selected) {
    return (
      <div className="labs-flat-body labs-datasets-page">
        <div className="labs-dataset-detail-heading">
          <button
            aria-label="Back to Datasets"
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
          <LabStatusBadge
            label={datasetStatus(selected)}
            value={selected.status}
          />
        </div>
        <LabModelDataset
          taskset={selected}
          onOpenFiles={() => onOpenFiles(selected.id)}
        />
      </div>
    );
  }

  return (
    <div className="labs-flat-body labs-datasets-page">
      <div className="labs-resource-actions">
        <button className="training-button" type="button" onClick={onCreate}>
          Create Dataset
        </button>
      </div>
      <div className="labs-workproduct-toolbar">
        <label className="labs-search">
          <Search size={14} />
          <input
            aria-label="Search Datasets"
            placeholder="Search Datasets"
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
              <th>Dataset</th>
              <th>Training</th>
              <th>Validation</th>
              <th>Frozen Eval</th>
              <th>Graders</th>
              <th>Models</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((taskset) => {
              const modelCount = modelCountByDataset.get(taskset.id) ?? 0;
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
                  <td>{splitCount(taskset, "train")}</td>
                  <td>{splitCount(taskset, "validation")}</td>
                  <td>{splitCount(taskset, "frozen_eval")}</td>
                  <td>{taskset.graders.length}</td>
                  <td>{modelCount || "—"}</td>
                  <td>{formatCompactDate(taskset.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!visible.length ? <div className="labs-table-empty">No Datasets match this view.</div> : null}
      <DatasetPagination
        page={page}
        total={filtered.length}
        onChange={setPage}
      />
    </div>
  );
}

function splitCount(taskset: Taskset, split: Taskset["tasks"][number]["split"]): number {
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
    <nav className="labs-pagination" aria-label="Dataset pages">
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>Previous</button>
      <span>{page} of {pages}</span>
      <button type="button" disabled={page >= pages} onClick={() => onChange(page + 1)}>Next</button>
    </nav>
  );
}
