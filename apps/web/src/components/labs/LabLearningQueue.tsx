import { useEffect, useState } from "react";
import type {
  ModelComparisonSeries,
  ModelComparisonSeriesEntry,
  TaskDataRecord,
  Taskset,
  TrainingStateResponse,
} from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import { LabStatusBadge } from "./LabStatusBadge";

export function LabLearningQueue({
  onOpenSeries,
  onToast,
  state,
  training,
}: {
  onOpenSeries: (seriesId: string) => void;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
  state: TrainingStateResponse;
  training: ReturnType<typeof useTraining>;
}) {
  const activeSeries = state.comparisonSeries.filter((series) => series.status === "active" && series.scheduleSealedAt);
  const [seriesId, setSeriesId] = useState(activeSeries[0]?.id ?? "");
  const series = activeSeries.find((candidate) => candidate.id === seriesId) ?? null;
  const entries = seriesEntries(state, series?.id ?? null);
  const next = series ? nextDailyRelease(series, entries) : null;
  const pool = series ? tasksetByRef(state, series.eligibleTaskPool) : null;
  const usedFamilies = new Set(entries.flatMap((entry) => entry.taskSelection?.derivedFamilyKeys ?? []));
  const rows = (pool?.tasks ?? []).filter((task) => task.split === "train");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const selected = rows.filter((task) => selectedIds.has(task.id));
  const selectedFamilies = new Set(selected.map(taskFamily));

  useEffect(() => {
    setSelectedIds(new Set());
    setDrawerOpen(false);
  }, [seriesId, next?.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key.toLowerCase() !== "q" || event.metaKey || event.ctrlKey || event.altKey
        || target?.matches("input, textarea, select, button, [contenteditable=true]") || !selectedIds.size) return;
      event.preventDefault();
      setDrawerOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds.size]);

  function toggle(task: TaskDataRecord) {
    if (usedFamilies.has(taskFamily(task))) return;
    setSelectedIds((current) => {
      const nextIds = new Set(current);
      if (nextIds.has(task.id)) nextIds.delete(task.id);
      else nextIds.add(task.id);
      return nextIds;
    });
  }

  async function queue() {
    if (!series || !next || !pool || !selected.length) return;
    const now = new Date().toISOString();
    const observed = selected.map(taskObservedAt).filter((value): value is string => Boolean(value)).sort();
    const result = await training.actions.queueComparisonRelease({
      seriesId: series.id,
      scheduleEntryId: next.id,
      taskSelection: {
        source: "replay_evidence",
        taskIds: selected.map((task) => task.id),
        observedFrom: observed[0] ?? pool.createdAt,
        observedTo: observed.at(-1) ?? pool.updatedAt,
        reviewedAt: now,
        reviewedBy: state.profileId,
        sourceTaskset: { id: pool.id, revision: pool.revision, contentHash: pool.contentHash },
      },
      expectedSeriesRevision: series.revision,
    });
    if (!result) {
      onToast(`Couldn’t queue ${next.label}.`, "error");
      return;
    }
    setDrawerOpen(false);
    setSelectedIds(new Set());
    onToast(`${result.entry.label} was materialized and is ready. No Run was launched.`, "success");
    onOpenSeries(series.id);
  }

  return <div className="labs-learning-queue">
    <section className="training-detail-section">
      <div className="labs-project-trends-heading"><div><h2>Learning queue</h2><p>Select verified evidence for the next immutable release. Queueing never starts training.</p></div><label className="labs-learning-series-select"><span>Series</span><select value={seriesId} onChange={(event) => setSeriesId(event.currentTarget.value)}><option value="">Select an active series</option>{activeSeries.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label></div>
      {series && next && pool ? <>
        <div className="labs-learning-release-banner"><div><strong>Next · {next.label}</strong><span>{next.trainableRank} trainable rank · {parentRule(next.parentRule)}</span></div><div><strong>{selected.length} tasks</strong><span>{selectedFamilies.size} independent families</span></div><button className="training-button" disabled={!selected.length} type="button" onClick={() => setDrawerOpen(true)}>Queue release <kbd>Q</kbd></button></div>
        <div className="training-table-wrap"><table className="training-data-table labs-learning-table"><thead><tr><th>Select</th><th>Observed</th><th>Task</th><th>Issue / source</th><th>Family</th><th>Prior exposure</th><th>Eligibility</th></tr></thead><tbody>{rows.map((task) => {
          const family = taskFamily(task);
          const blocked = usedFamilies.has(family);
          const observedAt = taskObservedAt(task);
          return <tr key={task.id}><td><input aria-label={`Select ${task.id}`} checked={selectedIds.has(task.id)} disabled={blocked} type="checkbox" onChange={() => toggle(task)} /></td><td>{observedAt ? formatDateTime(observedAt) : <><strong>Unavailable</strong><small>Replay imported {formatDateTime(pool.createdAt)}</small></>}</td><td><strong>{task.id}</strong><small>{taskPreview(task)}</small></td><td>{metadataText(task, "failureReason") ?? "Replay evidence"}<small>{metadataText(task, "source") ?? pool.name}</small></td><td>{family}</td><td>{blocked ? "Used in earlier release" : "Not used in this series"}</td><td><LabStatusBadge label={blocked ? "quarantined" : "eligible"} value={blocked ? "rejected" : "ready"} /></td></tr>;
        })}</tbody></table></div>
      </> : <div className="training-run-placeholder">{!activeSeries.length ? "No sealed active Comparison Series is available." : !next ? "Every daily release in this series has already been materialized." : "The eligible Taskset pool is unavailable."}</div>}
    </section>
    {drawerOpen && series && next && pool ? <aside aria-label="Queue release review" className="labs-learning-drawer"><header><div><h3>Queue {next.label}</h3><p>Review the immutable release before creating it.</p></div><button aria-label="Close queue review" type="button" onClick={() => setDrawerOpen(false)}>×</button></header><dl>
      <div><dt>Model Project</dt><dd>{state.modelProjects.find((project) => project.id === series.modelProjectId)?.name ?? series.modelProjectId}</dd></div>
      <div><dt>Parent</dt><dd>{parentRule(next.parentRule)}</dd></div>
      <div><dt>Rank</dt><dd>{next.trainableRank}</dd></div>
      <div><dt>Grader</dt><dd>{series.grader.id}<small>{shortId(series.grader.contentHash)}</small></dd></div>
      <div><dt>Tasks</dt><dd>{selected.length} across {selectedFamilies.size} families</dd></div>
      <div><dt>Evaluation plan</dt><dd>Current cohort + development + retained + prior disclosed cohorts</dd></div>
    </dl><div className="labs-learning-selected-tasks">{selected.map((task) => <span key={task.id}>{task.id}</span>)}</div><p className="labs-detail-copy">This action materializes one immutable Taskset release and leaves it ready. Start is a separate visible action in the Comparison Series.</p><footer><button className="training-button secondary" type="button" onClick={() => setDrawerOpen(false)}>Cancel</button><button className="training-button" disabled={Boolean(training.busyAction)} type="button" onClick={() => void queue()}>{training.busyAction ? "Queueing…" : "Queue release"}</button></footer></aside> : null}
  </div>;
}

export function LabLearningReviewHistory({ onOpenSeries, state }: { onOpenSeries: (seriesId: string) => void; state: TrainingStateResponse }) {
  const entries = state.comparisonSeriesEntries.filter((entry) => entry.taskSelection).sort((left, right) => right.taskSelection!.reviewedAt.localeCompare(left.taskSelection!.reviewedAt));
  return <section className="training-detail-section"><div className="labs-project-trends-heading"><div><h2>Review history</h2><p>Immutable selections, exclusions, generated releases, and resulting Runs.</p></div><span>{entries.length} releases</span></div><div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Reviewed</th><th>Series / release</th><th>Source</th><th>Tasks</th><th>Families</th><th>Run</th><th>Status</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td>{formatDateTime(entry.taskSelection!.reviewedAt)}<small>Observed {formatObserved(entry.taskSelection!.observedFrom, entry.taskSelection!.observedTo)}</small></td><td><button className="labs-version-row-button" type="button" onClick={() => onOpenSeries(entry.seriesId)}><strong>{state.comparisonSeries.find((series) => series.id === entry.seriesId)?.name ?? entry.seriesId}</strong><small>{entry.label}</small></button></td><td>{entry.taskSelection!.source.replaceAll("_", " ")}</td><td>{entry.taskSelection!.taskIds.length}</td><td>{entry.taskSelection!.derivedFamilyKeys.length}</td><td>{entry.modelRunId ? shortId(entry.modelRunId) : "Not started"}</td><td><LabStatusBadge label={entry.status} value={entry.status} /></td></tr>)}{!entries.length ? <tr><td colSpan={7}>No learning releases have been reviewed yet.</td></tr> : null}</tbody></table></div></section>;
}

function seriesEntries(state: TrainingStateResponse, seriesId: string | null): ModelComparisonSeriesEntry[] { return seriesId ? state.comparisonSeriesEntries.filter((entry) => entry.seriesId === seriesId) : []; }
function nextDailyRelease(series: ModelComparisonSeries, entries: ModelComparisonSeriesEntry[]) { const existing = new Set(entries.map((entry) => entry.scheduleEntryId)); return series.schedule.find((scheduled) => scheduled.role === "daily_residual" && !existing.has(scheduled.id)) ?? null; }
function tasksetByRef(state: TrainingStateResponse, ref: { id: string; revision: number; contentHash: string }): Taskset | null { return [...state.tasksets, ...state.modelTasksets].find((taskset) => taskset.id === ref.id && taskset.revision === ref.revision && taskset.contentHash === ref.contentHash) ?? null; }
function taskFamily(task: TaskDataRecord): string { return task.clusterKey || (typeof task.metadata.scenarioFamily === "string" ? task.metadata.scenarioFamily : task.id); }
function taskObservedAt(task: TaskDataRecord): string | null { const value = task.metadata.observedAt; return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null; }
function metadataText(task: TaskDataRecord, key: string): string | null { const value = task.metadata[key]; return typeof value === "string" && value.trim() ? value : null; }
function taskPreview(task: TaskDataRecord): string { const input = task.input; const raw = typeof input.prompt === "string" ? input.prompt : JSON.stringify(input); return raw.length > 160 ? `${raw.slice(0, 157)}…` : raw; }
function parentRule(value: string) { return value === "accepted_daily_head" ? "Last accepted daily head" : value === "accepted_seed" ? "Accepted seed" : "Frozen base"; }
function formatDateTime(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatObserved(from: string, to: string) { return from === to ? formatDateTime(from) : `${formatDateTime(from)} – ${formatDateTime(to)}`; }
function shortId(value: string) { return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value; }
