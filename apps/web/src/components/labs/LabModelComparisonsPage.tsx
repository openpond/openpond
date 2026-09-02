import { useState } from "react";
import type {
  ModelComparisonSeries,
  ModelRun,
  TrainingStateResponse,
} from "@openpond/contracts";

import type { ClientConnection } from "../../api";
import type { useTraining } from "../../hooks/useTraining";
import { statusLabel } from "../training/training-model-data";
import { LabComparisonSeriesCreateDialog } from "./LabComparisonSeriesCreateDialog";
import { LabComparisonSeriesDetail } from "./LabComparisonSeriesDetail";
import { LabStatusBadge } from "./LabStatusBadge";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";

export function LabModelComparisonsPage({
  connection,
  onOpenEvaluation,
  onOpenProject,
  onOpenRun,
  onOpenTaskset,
  onOpenVersion,
  onSelectedEntryIdChange,
  onSelectedSeriesIdChange,
  onToast,
  selectedSeriesId,
  selectedEntryId,
  state,
  training,
}: {
  connection: ClientConnection | null;
  onOpenEvaluation: (evaluationRunId: string) => void;
  onOpenProject: (projectId: string) => void;
  onOpenRun: (projectId: string, runId: string) => void;
  onOpenTaskset: (tasksetId: string) => void;
  onOpenVersion: (projectId: string, versionId: string) => void;
  onSelectedEntryIdChange: (seriesId: string, entryId: string | null) => void;
  onSelectedSeriesIdChange: (seriesId: string | null) => void;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
  selectedSeriesId: string | null;
  selectedEntryId: string | null;
  state: TrainingStateResponse | null;
  training: ReturnType<typeof useTraining>;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [dateWindow, setDateWindow] = useState("all");
  const [showAllStandalone, setShowAllStandalone] = useState(false);
  const series = state?.comparisonSeries.find((candidate) => candidate.id === selectedSeriesId) ?? null;
  if (series && state) {
    return <LabComparisonSeriesDetail
      connection={connection}
      onBack={() => onSelectedSeriesIdChange(null)}
      onOpenEvaluation={onOpenEvaluation}
      onOpenProject={onOpenProject}
      onOpenRun={onOpenRun}
      onOpenTaskset={onOpenTaskset}
      onOpenVersion={onOpenVersion}
      onSelectedEntryIdChange={(entryId) => onSelectedEntryIdChange(series.id, entryId)}
      onToast={onToast}
      series={series}
      selectedEntryId={selectedEntryId}
      state={state}
      training={training}
    />;
  }
  const summaries = comparisonSeriesSummaries(state);
  const standaloneRuns = standaloneTrainingRuns(state);
  const filteredSummaries = summaries.filter((summary) =>
    (!query.trim() || `${summary.series.name} ${summary.projectName}`.toLowerCase().includes(query.trim().toLowerCase()))
    && (!projectFilter || summary.series.modelProjectId === projectFilter)
    && (!statusFilter || summary.series.status === statusFilter)
    && withinWindow(summary.lastActivity, dateWindow));
  const filteredStandalone = standaloneRuns.filter((run) =>
    (!projectFilter || run.modelId === projectFilter)
    && withinWindow(run.startedAt, dateWindow));
  const visibleStandalone = showAllStandalone ? filteredStandalone : filteredStandalone.slice(0, 25);
  const active = summaries.filter((summary) => summary.series.status === "active").length;
  const attention = summaries.filter((summary) => summary.attention).length;
  const masters = new Set(summaries.flatMap((summary) => summary.masterEntryId ? [summary.masterEntryId] : []));

  async function createSeries(next: ModelComparisonSeries) {
    const saved = await training.actions.saveComparisonSeries(next);
    if (!saved) return false;
    onToast("Comparison Series draft created. Review it before sealing.", "success");
    onSelectedSeriesIdChange(saved.id);
    return true;
  }

  return (
    <div className="labs-flat-body labs-resource-page labs-comparisons-page" data-profile-id={state?.profileId}>
      <ModelProjectPageHeader
        title="Model Comparisons"
        description="Saved continual-learning series, exact branch lineage, ordinary Evaluation Runs, and explicit Master promotion."
        actions={<button className="training-button" disabled={!state || Boolean(training.busyAction)} type="button" onClick={() => setCreateOpen(true)}>New series</button>}
        metrics={[
          { label: "Series", value: summaries.length, hint: `${active} active` },
          { label: "Needs attention", value: attention, hint: "failed, held, or candidate releases" },
          { label: "Master releases", value: masters.size, hint: "resolved from active Model Bindings" },
          { label: "Standalone Runs", value: standaloneRuns.length, hint: "not attached to a series" },
        ]}
      />
      <section aria-label="Comparison filters" className="labs-comparison-filters">
        <label><span>Search</span><input placeholder="Series or project" value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></label>
        <label><span>Project</span><select value={projectFilter} onChange={(event) => setProjectFilter(event.currentTarget.value)}><option value="">All projects</option>{state?.modelProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value)}><option value="">All statuses</option><option value="draft">Draft</option><option value="active">Active</option><option value="completed">Completed</option><option value="archived">Archived</option></select></label>
        <label><span>Date</span><select value={dateWindow} onChange={(event) => setDateWindow(event.currentTarget.value)}><option value="all">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></label>
      </section>
      <section className="training-detail-section">
        <div className="labs-project-trends-heading"><div><h2>Comparison Series</h2><p>Persistent series are the primary comparison object. Date reflects real activity.</p></div></div>
        <div className="labs-comparison-series-grid">
          {filteredSummaries.map((summary) => <button className="labs-resource-card labs-comparison-series-card" key={summary.series.id} type="button" onClick={() => onSelectedSeriesIdChange(summary.series.id)}>
            <header><div><strong>{summary.series.name}</strong><small>{summary.projectName}</small></div><LabStatusBadge label={summary.series.status} value={summary.series.status} /></header>
            <dl>
              <div><dt>Last activity</dt><dd>{formatDate(summary.lastActivity)}</dd></div>
              <div><dt>Experimental head</dt><dd>{summary.acceptedHeadLabel ?? "None"}</dd></div>
              <div><dt>Current pass</dt><dd>{summary.currentLabel ?? "Not started"}</dd></div>
              <div><dt>Master</dt><dd>{summary.masterLabel ?? "Not set"}</dd></div>
            </dl>
            <footer><span>{summary.completedEntries} / {summary.series.schedule.length} releases</span><span>{summary.attention ? "Review needed" : "On track"}</span></footer>
          </button>)}
          {!filteredSummaries.length ? <div className="training-run-placeholder">{summaries.length ? "No Comparison Series matches these filters." : "No Comparison Series exists yet. Create a draft to define the schedule; no Run starts until a ready release is explicitly started."}</div> : null}
        </div>
      </section>
      <section className="training-detail-section">
        <div className="labs-project-trends-heading"><div><h2>Standalone Runs</h2><p>Training Runs outside a series remain inspectable and cannot be mistaken for series releases.</p></div></div>
        <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Date</th><th>Project</th><th>Run</th><th>Taskset</th><th>Status</th></tr></thead><tbody>
          {visibleStandalone.map((run) => <tr key={run.id}><td><strong>{formatDate(run.startedAt)}</strong><small>{formatTime(run.startedAt)}</small></td><td><button className="labs-version-row-button" type="button" onClick={() => onOpenProject(run.modelId)}>{projectName(state, run.modelId)}</button></td><td><button className="labs-version-row-button" type="button" onClick={() => onOpenRun(run.modelId, run.id)}>{shortId(run.id)}</button></td><td><button className="labs-version-row-button" type="button" onClick={() => onOpenTaskset(run.taskset.id)}>{tasksetName(state, run.taskset.id)}</button></td><td><LabStatusBadge label={statusLabel(run.status)} value={run.status} /></td></tr>)}
          {!filteredStandalone.length ? <tr><td colSpan={5}>No standalone training Runs match these filters.</td></tr> : null}
        </tbody></table></div>
        {!showAllStandalone && filteredStandalone.length > visibleStandalone.length ? <button className="training-button secondary" type="button" onClick={() => setShowAllStandalone(true)}>Show all {filteredStandalone.length} standalone Runs</button> : null}
      </section>
      {createOpen && state ? <LabComparisonSeriesCreateDialog busy={Boolean(training.busyAction)} onClose={() => setCreateOpen(false)} onCreate={createSeries} profileId={state.profileId} state={state} /> : null}
    </div>
  );
}

type SeriesSummary = {
  series: ModelComparisonSeries;
  projectName: string;
  lastActivity: string;
  acceptedHeadLabel: string | null;
  currentLabel: string | null;
  masterEntryId: string | null;
  masterLabel: string | null;
  completedEntries: number;
  attention: boolean;
};

function comparisonSeriesSummaries(state: TrainingStateResponse | null): SeriesSummary[] {
  if (!state) return [];
  const projects = new Map(state.modelProjects.map((project) => [project.id, project]));
  const entriesBySeries = new Map<string, typeof state.comparisonSeriesEntries>();
  for (const entry of state.comparisonSeriesEntries) {
    const current = entriesBySeries.get(entry.seriesId) ?? [];
    current.push(entry);
    entriesBySeries.set(entry.seriesId, current);
  }
  return state.comparisonSeries.map((series) => {
    const entries = entriesBySeries.get(series.id) ?? [];
    const acceptedHead = entries.find((entry) => entry.id === series.acceptedDailyHeadEntryId) ?? null;
    const current = [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
    const binding = state.modelBindings.find((candidate) => candidate.status === "active" && candidate.profileId === series.profileId && candidate.role === series.productionBinding.role && candidate.roleTargetId === series.productionBinding.roleTargetId) ?? null;
    const master = binding ? entries.find((entry) => state.modelVersions.find((version) => version.id === entry.modelVersionId)?.artifactLineageId === binding.modelArtifactLineageId) ?? null : null;
    return {
      series,
      projectName: projects.get(series.modelProjectId)?.name ?? series.modelProjectId,
      lastActivity: current?.updatedAt ?? series.updatedAt,
      acceptedHeadLabel: acceptedHead?.label ?? null,
      currentLabel: current?.label ?? null,
      masterEntryId: master?.id ?? null,
      masterLabel: master?.label ?? null,
      completedEntries: entries.filter((entry) => ["accepted", "rejected", "no_signal", "failed", "cancelled"].includes(entry.status)).length,
      attention: entries.some((entry) => ["candidate", "rejected", "failed"].includes(entry.status)),
    };
  }).sort((left, right) => right.lastActivity.localeCompare(left.lastActivity));
}

function standaloneTrainingRuns(state: TrainingStateResponse | null): ModelRun[] {
  if (!state) return [];
  const linked = new Set(state.comparisonSeriesEntries.flatMap((entry) => entry.modelRunId ? [entry.modelRunId] : []));
  return state.modelRuns.filter((run) => run.kind === "training" && !linked.has(run.id)).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function projectName(state: TrainingStateResponse | null, id: string) { return state?.modelProjects.find((project) => project.id === id)?.name ?? id; }
function tasksetName(state: TrainingStateResponse | null, id: string) { return [...(state?.tasksets ?? []), ...(state?.modelTasksets ?? [])].find((taskset) => taskset.id === id)?.name ?? id; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(new Date(value)); }
function formatTime(value: string) { return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function shortId(value: string) { return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value; }
function withinWindow(value: string, window: string) {
  if (window === "all") return true;
  return Date.now() - new Date(value).getTime() <= Number(window) * 86_400_000;
}
