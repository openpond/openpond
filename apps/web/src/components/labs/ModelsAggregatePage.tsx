import { useMemo } from "react";
import type { CreateImproveRun, TrainingStateResponse } from "@openpond/contracts";
import type { LabWorkproductSummary } from "./lab-workproducts";
import { labModelVersions } from "./lab-models";
import { formatDateTime, statusLabel } from "../training/training-model-data";
import { LabStatusBadge } from "./LabStatusBadge";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";

export interface ModelsAggregateRow {
  ref: string;
  modelId: string | null;
  modelName: string;
  kind: string;
  label: string;
  status: string;
  tasksetId: string;
  updatedAt: string;
}

export function modelAggregateRows(page: "runs" | "versions", state: TrainingStateResponse, models: LabWorkproductSummary[], runs: CreateImproveRun[]): ModelsAggregateRow[] {
  const modelNames = new Map(models.map((model) => [model.id, model.name]));
  if (page === "versions") {
    return models.flatMap((model) => labModelVersions(model, runs, state).map((version) => ({
      ref: `version:${version.lineage.id}`, modelId: model.id, modelName: model.name,
      kind: "Model version", label: `Version ${version.number}`, status: version.current ? "current" : version.lineage.promotable ? "available" : "pending",
      tasksetId: version.taskset?.id ?? "", updatedAt: version.lineage.importedAt,
    }))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const lifecycle = state.modelRuns.filter((run) => run.kind !== "evaluation" && modelNames.has(run.modelId));
  const lifecycleIds = new Set(lifecycle.map((run) => run.id));
  const plans = new Map(state.plans.map((plan) => [plan.id, plan]));
  const rows: ModelsAggregateRow[] = lifecycle.map((run) => ({
    ref: `model-run:${run.id}`, modelId: run.modelId, modelName: modelNames.get(run.modelId)!, kind: run.kind === "rollout_smoke" ? "Rollout check" : "Training", label: run.id,
    status: run.status, tasksetId: run.taskset.id, updatedAt: run.updatedAt,
  }));
  for (const job of state.jobs) {
    if (lifecycleIds.has(job.id) || (typeof job.metadata.modelRunId === "string" && lifecycleIds.has(job.metadata.modelRunId))) continue;
    const plan = plans.get(job.planId);
    if (!plan?.modelId || !modelNames.has(plan.modelId)) continue;
    rows.push({ ref: `job:${job.id}`, modelId: plan.modelId, modelName: modelNames.get(plan.modelId)!, kind: "Training", label: job.id, status: job.status, tasksetId: plan.tasksetId, updatedAt: job.updatedAt });
  }
  for (const run of state.rewardModelRuns) {
    rows.push({ ref: `reward-run:${run.id}`, modelId: null, modelName: `Reward ${run.rewardModelId}`, kind: "Reward training", label: run.id, status: run.status, tasksetId: run.taskset.id, updatedAt: run.updatedAt });
  }
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function ModelsAggregatePage({ page, state, models, runs, query, after, onSearch, onPage, onOpen, onNewRun }: {
  page: "runs" | "versions"; state: TrainingStateResponse | null; models: LabWorkproductSummary[]; runs: CreateImproveRun[];
  query: string; after: string | null; onSearch: (query: string) => void; onPage: (after: string | null) => void;
  onOpen: (row: ModelsAggregateRow) => void; onNewRun: () => void;
}) {
  const rows = useMemo(() => state ? modelAggregateRows(page, state, models, runs) : [], [page, state, models, runs]);
  const search = query.trim().toLowerCase();
  const filtered = search ? rows.filter((row) => `${row.modelName} ${row.kind} ${row.label}`.toLowerCase().includes(search)) : rows;
  const start = after ? filtered.findIndex((row) => row.ref === after) + 1 : 0;
  const visible = filtered.slice(start, start + 25);
  return <div className="labs-flat-body labs-resource-page">
    <ModelProjectPageHeader title={page === "runs" ? "Runs" : "Versions"} description={page === "runs" ? "Training and reward training across your models." : "Trained versions with their parent model and source Taskset."} actions={page === "runs" ? <button className="training-button" type="button" onClick={onNewRun}>New training run</button> : undefined} />
    <label className="labs-search"><span className="sr-only">Search {page}</span><input placeholder={`Search ${page}`} value={query} onChange={(event) => onSearch(event.target.value)} /></label>
    {!state ? <p role="status">Loading {page}…</p> : <div className="training-table-wrap"><table className="training-data-table">
      <thead><tr><th>{page === "runs" ? "Run" : "Version"}</th><th>Model or reward</th><th>Type</th><th>Status</th><th>Taskset</th><th>Updated</th></tr></thead>
      <tbody>{visible.map((row) => <tr key={row.ref}>
        <td><button className="labs-version-row-button" type="button" onClick={() => onOpen(row)}>{row.label}</button></td>
        <td>{row.modelName}</td><td>{row.kind}</td><td><LabStatusBadge label={statusLabel(row.status)} value={row.status} /></td><td>{row.tasksetId}</td><td>{formatDateTime(row.updatedAt)}</td>
      </tr>)}{!visible.length ? <tr><td colSpan={6}>No {page} match this view.</td></tr> : null}</tbody>
    </table></div>}
    <div className="model-build-actions">
      {after ? <button className="training-button secondary" type="button" onClick={() => onPage(null)}>First page</button> : null}
      {filtered.length > start + 25 ? <button className="training-button secondary" type="button" onClick={() => onPage(visible.at(-1)!.ref)}>Next page</button> : null}
    </div>
  </div>;
}
