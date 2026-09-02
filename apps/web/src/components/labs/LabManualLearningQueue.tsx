import { useEffect, useState } from "react";
import type {
  ModelComparisonSeries,
  TaskDataRecord,
  Taskset,
  TrainingStateResponse,
} from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import { LabStatusBadge } from "./LabStatusBadge";

export function LabManualLearningQueue({
  onOpenSeries,
  onToast,
  series,
  state,
  training,
}: {
  onOpenSeries: (seriesId: string) => void;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
  series: ModelComparisonSeries;
  state: TrainingStateResponse;
  training: ReturnType<typeof useTraining>;
}) {
  const entries = state.comparisonSeriesEntries.filter((entry) => entry.seriesId === series.id);
  const next = nextDailyRelease(series, entries.map((entry) => entry.scheduleEntryId));
  const pool = tasksetByRef(state, series.eligibleTaskPool);
  const usedFamilies = new Set(entries.flatMap((entry) => entry.taskSelection?.derivedFamilyKeys ?? []));
  const rows = (pool?.tasks ?? []).filter((task) => task.split === "train");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const selected = rows.filter((task) => selectedIds.has(task.id));
  const selectedFamilies = new Set(selected.map(taskFamily));

  useEffect(() => {
    setSelectedIds(new Set());
    setDrawerOpen(false);
  }, [series.id, next?.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key.toLowerCase() !== "q" || event.metaKey || event.ctrlKey || event.altKey
        || target?.matches("input, textarea, select, button, [contenteditable=true]") || !selectedIds.size
      ) return;
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
    if (!next || !pool || !selected.length) return;
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

  if (!next || !pool) {
    return (
      <div className="training-run-placeholder">
        {!next ? "Every daily release in this comparison has already been materialized." : "The eligible Taskset pool is unavailable."}
      </div>
    );
  }

  return (
    <div className="labs-manual-learning-queue">
      <div className="labs-learning-flow-note">
        <strong>Manual evidence selection</strong>
        <span>This comparison has no structured issue review for {next.label}. Select verified training evidence directly.</span>
      </div>
      <div className="labs-learning-release-banner">
        <div><strong>Next · {next.label}</strong><span>{next.trainableRank} trainable rank · {parentRule(next.parentRule)}</span></div>
        <div><strong>{selected.length} tasks</strong><span>{selectedFamilies.size} independent families</span></div>
        <button className="training-button" disabled={!selected.length} type="button" onClick={() => setDrawerOpen(true)}>Review release <kbd>Q</kbd></button>
      </div>
      <div className="training-table-wrap">
        <table className="training-data-table labs-learning-table">
          <thead><tr><th>Select</th><th>Observed</th><th>Task</th><th>Issue / source</th><th>Family</th><th>Prior exposure</th><th>Eligibility</th></tr></thead>
          <tbody>
            {rows.map((task) => {
              const family = taskFamily(task);
              const blocked = usedFamilies.has(family);
              const observedAt = taskObservedAt(task);
              return (
                <tr key={task.id}>
                  <td><input aria-label={`Select ${task.id}`} checked={selectedIds.has(task.id)} disabled={blocked} type="checkbox" onChange={() => toggle(task)} /></td>
                  <td>{observedAt ? formatDateTime(observedAt) : <><strong>Unavailable</strong><small>Imported {formatDateTime(pool.createdAt)}</small></>}</td>
                  <td><strong>{task.id}</strong><small>{taskPreview(task)}</small></td>
                  <td>{metadataText(task, "failureReason") ?? "Verified evidence"}<small>{metadataText(task, "source") ?? pool.name}</small></td>
                  <td>{family}</td>
                  <td>{blocked ? "Used in an earlier release" : "Not used in this comparison"}</td>
                  <td><LabStatusBadge label={blocked ? "quarantined" : "eligible"} value={blocked ? "rejected" : "ready"} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {drawerOpen ? (
        <aside aria-label="Queue release review" className="labs-learning-drawer">
          <header><div><h3>Queue {next.label}</h3><p>Review the immutable release before creating it.</p></div><button aria-label="Close queue review" type="button" onClick={() => setDrawerOpen(false)}>×</button></header>
          <dl>
            <div><dt>Model Project</dt><dd>{state.modelProjects.find((project) => project.id === series.modelProjectId)?.name ?? series.modelProjectId}</dd></div>
            <div><dt>Parent</dt><dd>{parentRule(next.parentRule)}</dd></div>
            <div><dt>New rank</dt><dd>{next.trainableRank}</dd></div>
            <div><dt>Grader</dt><dd>{series.grader.id}<small>{shortId(series.grader.contentHash)}</small></dd></div>
            <div><dt>Training examples</dt><dd>{selected.length} across {selectedFamilies.size} families</dd></div>
            <div><dt>Evaluation plan</dt><dd>Current cohort, development, retained, and prior disclosed cohorts</dd></div>
          </dl>
          <div className="labs-learning-selected-tasks">{selected.map((task) => <span key={task.id}>{task.id}</span>)}</div>
          <p className="labs-detail-copy">This creates one immutable Taskset release and leaves it ready. Starting training is a separate action in Model Comparisons.</p>
          <footer><button className="training-button secondary" type="button" onClick={() => setDrawerOpen(false)}>Cancel</button><button className="training-button" disabled={Boolean(training.busyAction)} type="button" onClick={() => void queue()}>{training.busyAction ? "Queueing…" : "Queue release"}</button></footer>
        </aside>
      ) : null}
    </div>
  );
}

function nextDailyRelease(series: ModelComparisonSeries, existingScheduleEntryIds: string[]) {
  const existing = new Set(existingScheduleEntryIds);
  return [...series.schedule]
    .sort((left, right) => left.ordinal - right.ordinal)
    .find((scheduled) => scheduled.role === "daily_residual" && !existing.has(scheduled.id)) ?? null;
}

function tasksetByRef(state: TrainingStateResponse, ref: { id: string; revision: number; contentHash: string }): Taskset | null {
  return [...state.tasksets, ...state.modelTasksets].find(
    (taskset) => taskset.id === ref.id && taskset.revision === ref.revision && taskset.contentHash === ref.contentHash,
  ) ?? null;
}

function taskFamily(task: TaskDataRecord): string {
  return task.clusterKey || (typeof task.metadata.scenarioFamily === "string" ? task.metadata.scenarioFamily : task.id);
}

function taskObservedAt(task: TaskDataRecord): string | null {
  const value = task.metadata.observedAt;
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function metadataText(task: TaskDataRecord, key: string): string | null {
  const value = task.metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function taskPreview(task: TaskDataRecord): string {
  const raw = typeof task.input.prompt === "string" ? task.input.prompt : JSON.stringify(task.input);
  return raw.length > 160 ? `${raw.slice(0, 157)}…` : raw;
}

function parentRule(value: string) {
  return value === "accepted_daily_head" ? "Last advanced daily head" : value === "accepted_seed" ? "Advanced seed" : "Frozen base";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function shortId(value: string) {
  return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}
