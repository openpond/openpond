import { useEffect, useMemo, useState } from "react";
import {
  resolveModelBindingPromotionGate,
  type ModelArtifactLineage,
  type ModelRun,
  type TrainingRunDetail,
  type TrainingStateResponse,
} from "@openpond/contracts";

import { api, type ClientConnection } from "../../api";
import type { useTraining } from "../../hooks/useTraining";
import { statusLabel } from "../training/training-model-data";
import { LabStatusBadge } from "./LabStatusBadge";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";

type TrainingController = ReturnType<typeof useTraining>;

type ComparisonRow = {
  run: ModelRun;
  jobId: string | null;
  projectName: string;
  tasksetName: string;
  trainTasks: number;
  evaluationTasks: number;
  rank: number | null;
  parent: string;
  lineage: ModelArtifactLineage | null;
  main: boolean;
};

export function LabModelComparisonsPage({
  connection,
  state,
  training,
  onOpenProject,
  onOpenRun,
  onToast,
}: {
  connection: ClientConnection | null;
  state: TrainingStateResponse | null;
  training: TrainingController;
  onOpenProject: (projectId: string) => void;
  onOpenRun: (projectId: string, runId: string) => void;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
}) {
  const rows = useMemo(() => comparisonRows(state), [state]);
  const [details, setDetails] = useState<Map<string, TrainingRunDetail>>(new Map());
  const [baselineRunId, setBaselineRunId] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const jobIds = rows.flatMap((row) => row.jobId ? [row.jobId] : []);
    if (!connection || !jobIds.length) {
      setDetails(new Map());
      return () => { disposed = true; };
    }
    void Promise.all(jobIds.map(async (jobId) => {
      try {
        return [jobId, await api.trainingRunDetail(connection, jobId)] as const;
      } catch {
        return null;
      }
    })).then((results) => {
      if (!disposed) setDetails(new Map(results.flatMap((result) => result ? [result] : [])));
    });
    return () => { disposed = true; };
  }, [connection, rows]);

  const totalCost = rows.reduce((sum, row) => sum + cost(details.get(row.jobId ?? "") ?? null), 0);
  const current = rows.find((row) => row.main) ?? null;
  const baseline = rows.find((row) => row.run.id === baselineRunId) ?? current;
  const baselineScore = scores(baseline?.jobId ? details.get(baseline.jobId) ?? null : null).candidate;

  async function promote(row: ComparisonRow) {
    if (!row.lineage) return;
    const result = await training.actions.bindModel(row.lineage.id, "chat_manual", row.run.modelId);
    onToast(result ? `${row.projectName} candidate promoted to main.` : "Couldn’t promote this candidate.", result ? "success" : "error");
  }

  async function rollback(row: ComparisonRow) {
    const binding = state?.modelBindings.find((candidate) =>
      candidate.status === "active"
      && candidate.role === "chat_manual"
      && candidate.modelArtifactLineageId === row.lineage?.id,
    );
    if (!binding) return;
    const result = await training.actions.rollbackModelBinding(binding.id);
    onToast(result ? "Main rolled back to its recorded predecessor." : "Couldn’t roll back main.", result ? "success" : "error");
  }

  return (
    <div className="labs-flat-body labs-resource-page labs-comparisons-page">
      <ModelProjectPageHeader
        title="Model Comparisons"
        description="Compare immutable training runs chronologically, inspect their evidence, and explicitly promote an eligible Model Version to main."
        metrics={[
          { label: "Runs", value: rows.length },
          { label: "Current main", value: current?.projectName ?? "Not bound", hint: current?.run.id },
          { label: "Observed spend", value: formatCost(totalCost) },
        ]}
      />
      <section className="training-detail-section">
        <div className="labs-project-trends-heading">
          <div>
            <h2>Chronological comparison</h2>
            <p>Select a baseline to show candidate score deltas. Date is the primary grouping.</p>
          </div>
          {baseline ? <span>Baseline · {shortId(baseline.run.id)}</span> : null}
        </div>
        <div className="training-table-wrap">
          <table className="training-data-table labs-comparison-table">
            <thead><tr>
              <th>Date</th><th>Baseline</th><th>Line</th><th>Model Project</th><th>Run / Version</th>
              <th>Parent</th><th>Dataset</th><th>Rank</th><th>Updates</th><th>Evaluation</th>
              <th>Δ baseline</th><th>Cost</th><th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody>
              {rows.length ? rows.map((row) => {
                const detail = row.jobId ? details.get(row.jobId) ?? null : null;
                const evaluation = scores(detail);
                const progress = detail?.managedEvidence?.progress;
                const candidateDelta = baselineScore !== null && evaluation.candidate !== null
                  ? evaluation.candidate - baselineScore
                  : null;
                const gate = row.lineage ? resolveModelBindingPromotionGate(row.lineage) : null;
                const canPromote = Boolean(row.lineage && row.lineage.status === "imported" && gate && !row.main);
                return (
                  <tr key={row.run.id}>
                    <td><strong>{formatDate(row.run.startedAt)}</strong><small>{formatTime(row.run.startedAt)}</small></td>
                    <td><input aria-label={`Use ${row.run.id} as baseline`} checked={baseline?.run.id === row.run.id} name="comparison-baseline" type="radio" onChange={() => setBaselineRunId(row.run.id)} /></td>
                    <td><LabStatusBadge label={row.main ? "main" : "experiment"} value={row.main ? "succeeded" : "prepared"} /></td>
                    <td><button className="labs-version-row-button" type="button" onClick={() => onOpenProject(row.run.modelId)}>{row.projectName}</button></td>
                    <td><button className="labs-version-row-button" type="button" onClick={() => onOpenRun(row.run.modelId, row.run.id)}>{shortId(row.run.id)}<small>{row.lineage ? shortId(row.lineage.id) : "No Model Version"}</small></button></td>
                    <td>{row.parent}</td>
                    <td>{row.tasksetName}<small>{row.trainTasks} train · {row.evaluationTasks} eval</small></td>
                    <td>{row.rank ?? "—"}</td>
                    <td>{progress ? `${progress.committedOptimizerSteps} applied / ${Math.max(0, progress.targetOptimizerSteps - progress.committedOptimizerSteps)} skipped` : "—"}</td>
                    <td>{formatScore(evaluation.base)} → {formatScore(evaluation.candidate)}</td>
                    <td>{formatDelta(candidateDelta)}</td>
                    <td>{formatCost(cost(detail))}</td>
                    <td><LabStatusBadge label={rowStatus(row)} value={rowStatus(row)} /></td>
                    <td><div className="labs-comparison-actions">
                      <button className="training-button secondary" type="button" onClick={() => onOpenRun(row.run.modelId, row.run.id)}>Inspect</button>
                      {row.main ? <button className="training-button secondary" type="button" disabled={!state?.modelBindings.some((binding) => binding.status === "active" && binding.modelArtifactLineageId === row.lineage?.id && binding.rollbackTargetBindingId)} onClick={() => void rollback(row)}>Roll back</button> : <button className="training-button" type="button" disabled={!canPromote || Boolean(training.busyAction)} onClick={() => void promote(row)}>Promote</button>}
                    </div></td>
                  </tr>
                );
              }) : <tr><td colSpan={14}>No training Runs exist yet. Start a real Model Run to populate this comparison.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function comparisonRows(state: TrainingStateResponse | null): ComparisonRow[] {
  if (!state) return [];
  const projects = new Map(state.modelProjects.map((project) => [project.id, project] as const));
  const tasksets = new Map([...state.tasksets, ...state.modelTasksets].map((taskset) => [taskset.id, taskset] as const));
  const jobsByRun = new Map(state.jobs.flatMap((job) => typeof job.metadata.modelRunId === "string" ? [[job.metadata.modelRunId, job] as const] : []));
  const plans = new Map(state.plans.map((plan) => [plan.id, plan] as const));
  const lineages = new Map(state.models.map((lineage) => [lineage.id, lineage] as const));
  const mainLineages = new Set(state.modelBindings.filter((binding) => binding.status === "active" && binding.role === "chat_manual").map((binding) => binding.modelArtifactLineageId));
  return state.modelRuns
    .filter((run) => run.kind === "training")
    .map((run) => {
      const job = jobsByRun.get(run.id) ?? null;
      const plan = job ? plans.get(job.planId) ?? null : null;
      const taskset = tasksets.get(run.taskset.id);
      const lineage = run.adapterArtifactLineageId ? lineages.get(run.adapterArtifactLineageId) ?? null : null;
      const continuation = plan?.recipe && "continuation" in plan.recipe ? plan.recipe.continuation : null;
      const baseModel = plan?.recipe && "baseModel" in plan.recipe ? plan.recipe.baseModel.id : "Base";
      return {
        run,
        jobId: job?.id ?? null,
        projectName: projects.get(run.modelId)?.name ?? run.modelId,
        tasksetName: taskset?.name ?? run.taskset.id,
        trainTasks: taskset?.tasks.filter((task) => task.split === "train").length ?? 0,
        evaluationTasks: taskset?.tasks.filter((task) => task.split === "frozen_eval").length ?? 0,
        rank: plan?.recipe && "lora" in plan.recipe ? plan.recipe.lora.rank : null,
        parent: continuation ? shortId(continuation.sourceArtifact.jobId) : baseModel,
        lineage,
        main: Boolean(lineage && mainLineages.has(lineage.id)),
      };
    })
    .sort((left, right) => right.run.startedAt.localeCompare(left.run.startedAt));
}

function scores(detail: TrainingRunDetail | null): { base: number | null; candidate: number | null } {
  if (detail?.evaluation) return { base: detail.evaluation.base.meanScore, candidate: detail.evaluation.trained.meanScore };
  const evaluations = detail?.managedEvidence?.evaluations ?? [];
  return {
    base: evaluations.find((item) => item.kind === "baseline")?.score ?? null,
    candidate: evaluations.find((item) => item.kind === "candidate")?.score ?? null,
  };
}

function rowStatus(row: ComparisonRow): string {
  if (row.main) return "accepted";
  if (row.lineage?.status === "rejected") return "rejected";
  if (row.lineage?.promotable) return "candidate";
  if (row.run.status === "succeeded" && !row.lineage) return "no signal";
  return statusLabel(row.run.status);
}
function cost(detail: TrainingRunDetail | null): number { return detail?.managedEvidence?.cost.totalUsd ?? 0; }
function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(new Date(value)); }
function formatTime(value: string): string { return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function formatScore(value: number | null): string { return value === null ? "—" : value.toFixed(3); }
function formatDelta(value: number | null): string { return value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(3)}`; }
function formatCost(value: number): string { return `$${value.toFixed(3)}`; }
function shortId(value: string): string { return value.length > 20 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value; }
