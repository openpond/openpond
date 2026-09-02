import type {
  ModelComparisonSeries,
  ModelComparisonSeriesEntry,
  TrainingStateResponse,
} from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import { LabDailyEvalsWorkspace } from "./LabDailyEvalsWorkspace";
import { LabStatusBadge } from "./LabStatusBadge";

export function LabLearningQueue({
  onOpenSeries,
  onToast,
  series,
  state,
  training,
}: {
  onOpenSeries: (seriesId: string) => void;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
  series: ModelComparisonSeries | null;
  state: TrainingStateResponse;
  training: ReturnType<typeof useTraining>;
}) {
  return (
    <section className="training-detail-section labs-learning-review">
      {!series ? (
        <div className="training-run-placeholder">No sealed continual-learning series is available for a model.</div>
      ) : (
        <LabDailyEvalsWorkspace
          onOpenSeries={onOpenSeries}
          onToast={onToast}
          series={series}
          state={state}
          training={training}
        />
      )}
    </section>
  );
}

export function LabLearningReviewHistory({
  onOpenSeries,
  state,
}: {
  onOpenSeries: (seriesId: string) => void;
  state: TrainingStateResponse;
}) {
  const entries = state.comparisonSeriesEntries
    .filter((entry) => entry.taskSelection)
    .sort((left, right) => right.taskSelection!.reviewedAt.localeCompare(left.taskSelection!.reviewedAt));

  return (
    <section className="training-detail-section">
      <div className="labs-project-trends-heading">
        <div>
          <h2>Review history</h2>
          <p>Immutable review decisions, generated releases, and resulting Runs.</p>
        </div>
        <span>{entries.length} releases</span>
      </div>
      <div className="training-table-wrap">
        <table className="training-data-table">
          <thead>
            <tr><th>Reviewed</th><th>Comparison / release</th><th>Source</th><th>Tasks</th><th>Families</th><th>Run</th><th>Status</th></tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{formatDateTime(entry.taskSelection!.reviewedAt)}<small>Observed {formatObserved(entry.taskSelection!.observedFrom, entry.taskSelection!.observedTo)}</small></td>
                <td>
                  <button className="labs-version-row-button" type="button" onClick={() => onOpenSeries(entry.seriesId)}>
                    <strong>{state.comparisonSeries.find((series) => series.id === entry.seriesId)?.name ?? entry.seriesId}</strong>
                    <small>{entry.label}</small>
                  </button>
                </td>
                <td>{entry.taskSelection!.source.replaceAll("_", " ")}</td>
                <td>{entry.taskSelection!.taskIds.length}</td>
                <td>{entry.taskSelection!.derivedFamilyKeys.length}</td>
                <td>{entry.modelRunId ? shortId(entry.modelRunId) : "Not started"}</td>
                <td><LabStatusBadge label={entry.status} value={entry.status} /></td>
              </tr>
            ))}
            {!entries.length ? <tr><td colSpan={7}>No learning releases have been reviewed yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function reviewableSeries(state: TrainingStateResponse): ModelComparisonSeries[] {
  const ordered = state.comparisonSeries
    .filter((series) => series.status === "active" && series.scheduleSealedAt)
    .sort((left, right) => (
      seriesGeneration(right.id) - seriesGeneration(left.id)
      || right.updatedAt.localeCompare(left.updatedAt)
    ));
  const seenModels = new Set<string>();
  return ordered.filter((series) => {
    if (seenModels.has(series.modelProjectId)) return false;
    seenModels.add(series.modelProjectId);
    return true;
  });
}

function seriesGeneration(id: string): number {
  const match = /(?:^|-)v(\d+)(?:-|$)/i.exec(id);
  return match ? Number(match[1]) : 0;
}

export function preferredReviewSeries(
  state: TrainingStateResponse,
  series: ModelComparisonSeries[],
): ModelComparisonSeries | null {
  return series.find((candidate) => {
    const next = nextScheduledRelease(candidate, seriesEntries(state, candidate.id));
    return next && state.continualBenchIssueReviews.some(
      (review) => review.seriesId === candidate.id && review.scheduleEntryId === next.id && review.status !== "queued",
    );
  }) ?? series.find((candidate) => state.continualBenchIssueReviews.some((review) => review.seriesId === candidate.id)) ?? series[0] ?? null;
}

export function comparisonOptionLabel(state: TrainingStateResponse, series: ModelComparisonSeries): string {
  const project = state.modelProjects.find((candidate) => candidate.id === series.modelProjectId);
  return project?.name ?? series.name;
}

function seriesEntries(state: TrainingStateResponse, seriesId: string): ModelComparisonSeriesEntry[] {
  return state.comparisonSeriesEntries.filter((entry) => entry.seriesId === seriesId);
}

function nextScheduledRelease(series: ModelComparisonSeries, entries: ModelComparisonSeriesEntry[]) {
  const existing = new Set(entries.map((entry) => entry.scheduleEntryId));
  return [...series.schedule]
    .sort((left, right) => left.ordinal - right.ordinal)
    .find((scheduled) => !existing.has(scheduled.id)) ?? null;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatObserved(from: string, to: string) {
  return from === to ? formatDateTime(from) : `${formatDateTime(from)} – ${formatDateTime(to)}`;
}

function shortId(value: string) {
  return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}
