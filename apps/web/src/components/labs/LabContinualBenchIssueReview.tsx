import { useEffect, useMemo, useState } from "react";
import type {
  ContinualBenchIssueReview,
  ModelComparisonSeries,
  ModelComparisonSeriesEntry,
  TaskDataRecord,
  TrainingStateResponse,
} from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import { LabStatusBadge } from "./LabStatusBadge";

export function LabContinualBenchIssueReview({
  onOpenSeries,
  onToast,
  reviews,
  series,
  state,
  training,
}: {
  onOpenSeries: (seriesId: string) => void;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
  reviews: ContinualBenchIssueReview[];
  series: ModelComparisonSeries;
  state: TrainingStateResponse;
  training: ReturnType<typeof useTraining>;
}) {
  const entries = state.comparisonSeriesEntries.filter((entry) => entry.seriesId === series.id);
  const next = nextScheduledRelease(series, entries);
  const orderedReviews = [...reviews].sort(
    (left, right) => scheduleOrdinal(series, left.scheduleEntryId) - scheduleOrdinal(series, right.scheduleEntryId),
  );
  const preferred = orderedReviews.find((review) => review.scheduleEntryId === next?.id)
    ?? orderedReviews.find((review) => review.status !== "queued")
    ?? orderedReviews.at(-1)
    ?? null;
  const [reviewId, setReviewId] = useState(preferred?.id ?? "");
  const review = orderedReviews.find((candidate) => candidate.id === reviewId) ?? preferred;
  const [decisions, setDecisions] = useState(review?.decisions ?? []);
  const taskById = useMemo(() => taskIndex(state), [state.modelTasksets, state.tasksets]);

  useEffect(() => {
    setReviewId(preferred?.id ?? "");
  }, [series.id]);

  useEffect(() => {
    setDecisions(review?.decisions ?? []);
  }, [review?.id, review?.revision]);

  if (!review) return <div className="training-run-placeholder">No structured issue review is available.</div>;

  const canQueue = review.status === "reviewed" && next?.id === review.scheduleEntryId;
  const complete = decisions.every((decision) => decision.disposition && decision.note.trim());
  const includedCases = review.packet.cases.filter(
    (item) => decisions.find((decision) => decision.taskId === item.taskId)?.disposition === "include",
  );
  const trainingCases = includedCases.filter((item) => item.optimizerEligible);
  const holdoutCases = includedCases.filter((item) => !item.optimizerEligible);
  const deferred = decisions.filter((decision) => decision.disposition === "defer").length;
  const excluded = decisions.filter((decision) => decision.disposition === "exclude").length;

  async function saveReview() {
    if (!review || !complete) return;
    const now = new Date().toISOString();
    const saved = await training.actions.saveContinualBenchIssueReview({
      ...review,
      decisions,
      status: "reviewed",
      reviewedBy: state.profileId,
      reviewedAt: now,
      revision: review.revision + 1,
      updatedAt: now,
    });
    onToast(
      saved ? `${review.passLabel} decisions saved. Queueing remains separate.` : "The learning review was not saved.",
      saved ? "success" : "error",
    );
  }

  async function queueReview() {
    if (!review || !canQueue || !trainingCases.length) return;
    const pool = [...state.tasksets, ...state.modelTasksets].find(
      (taskset) => taskset.id === series.eligibleTaskPool.id
        && taskset.revision === series.eligibleTaskPool.revision
        && taskset.contentHash === series.eligibleTaskPool.contentHash,
    );
    if (!pool) {
      onToast("The comparison’s eligible Taskset is unavailable.", "error");
      return;
    }
    const queued = await training.actions.queueComparisonRelease({
      seriesId: series.id,
      scheduleEntryId: review.scheduleEntryId,
      taskSelection: next?.role === "seed" ? null : {
        source: "replay_evidence",
        taskIds: trainingCases.map((item) => item.taskId),
        observedFrom: review.packet.observedAt,
        observedTo: review.packet.observedAt,
        reviewedAt: review.reviewedAt!,
        reviewedBy: review.reviewedBy!,
        sourceTaskset: series.eligibleTaskPool,
      },
      expectedSeriesRevision: series.revision,
    });
    if (!queued) {
      onToast(`${review.passLabel} was not queued.`, "error");
      return;
    }
    const saved = await training.actions.saveContinualBenchIssueReview({
      ...review,
      status: "queued",
      queuedEntry: toEntryRef(queued.entry),
      revision: review.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    onToast(
      saved
        ? `${review.passLabel} is ready with an exact Taskset. No Training Run was started.`
        : `${review.passLabel} was queued, but its review receipt needs reconciliation.`,
      saved ? "success" : "error",
    );
  }

  return (
    <div className="labs-issue-review-workflow">
      <div className="labs-learning-release-banner labs-issue-review-banner">
        <div>
          <strong>{review.passLabel} · {review.packet.familyLabel}</strong>
          <span>{review.packet.cases.length} observed issues · {review.packet.severity} severity</span>
        </div>
        <div>
          <strong>{next?.id === review.scheduleEntryId ? "Next scheduled release" : releasePosition(review)}</strong>
          <span>{review.status === "pending" ? "Decisions required" : review.status === "reviewed" ? "Decisions saved" : "Release queued"}</span>
        </div>
        <LabStatusBadge label={review.status} value={review.status === "queued" ? "ready" : review.status} />
      </div>

      <div className="labs-issue-review-toolbar">
        <label className="labs-learning-series-select">
          <span>Release</span>
          <select
            aria-label="Release to review"
            value={review.id}
            onChange={(event) => setReviewId(event.currentTarget.value)}
          >
            {orderedReviews.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.passLabel} · {candidate.packet.familyLabel} · {candidate.status}
              </option>
            ))}
          </select>
        </label>
        <p>Decide whether each issue belongs in this release. Evaluation holdouts remain sealed and are never sent to the optimizer.</p>
      </div>

      <div className="training-table-wrap">
        <table className="training-data-table labs-issue-review-table">
          <thead><tr><th>Observed issue</th><th>Use</th><th>Decision</th><th>Reviewer note</th></tr></thead>
          <tbody>
            {review.packet.cases.map((item) => {
              const decision = decisions.find((candidate) => candidate.taskId === item.taskId)!;
              const task = taskById.get(item.taskId);
              const locked = review.status !== "pending";
              return (
                <tr key={item.taskId}>
                  <td><strong>{item.taskId}</strong><small>{task ? taskPreview(task) : "Issue details are preserved in the sealed Taskset."}</small></td>
                  <td>
                    <strong>{item.optimizerEligible ? "Training example" : "Evaluation holdout"}</strong>
                    <small>{item.optimizerEligible ? "May update the candidate policy" : "Never shown during training"}</small>
                  </td>
                  <td>
                    <select
                      aria-label={`Decision for ${item.taskId}`}
                      disabled={locked}
                      value={decision.disposition ?? ""}
                      onChange={(event) => {
                        const disposition = event.currentTarget.value as "include" | "defer" | "exclude";
                        setDecisions((current) => current.map((candidate) => (
                          candidate.taskId === item.taskId ? { ...candidate, disposition } : candidate
                        )));
                      }}
                    >
                      <option value="">Choose a decision</option>
                      <option value="include">{item.optimizerEligible ? "Include in training" : "Keep as holdout"}</option>
                      <option value="defer">Defer</option>
                      <option value="exclude">Exclude</option>
                    </select>
                  </td>
                  <td>
                    <input
                      aria-label={`Reviewer note for ${item.taskId}`}
                      disabled={locked}
                      placeholder={item.optimizerEligible ? "Why should the model learn from this?" : "Why is this a valid holdout?"}
                      value={decision.note}
                      onChange={(event) => {
                        const note = event.currentTarget.value;
                        setDecisions((current) => current.map((candidate) => (
                          candidate.taskId === item.taskId ? { ...candidate, note } : candidate
                        )));
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <details className="labs-issue-review-provenance">
        <summary>Technical provenance</summary>
        <dl className="labs-inline-facts">
          <div><dt>Issue packet</dt><dd className="labs-mono-value">{review.packet.contentHash}</dd></div>
          <div><dt>Split manifest</dt><dd className="labs-mono-value">{review.splitManifest.contentHash}</dd></div>
          <div><dt>Duplicate audit</dt><dd className="labs-mono-value">{review.packet.duplicateEvidence.contentHash}</dd></div>
          <div><dt>Leakage audit</dt><dd className="labs-mono-value">{review.packet.leakageEvidence.contentHash}</dd></div>
          <div><dt>Prior exposure</dt><dd className="labs-mono-value">{review.packet.priorExposureEvidence.contentHash}</dd></div>
        </dl>
      </details>

      <div className="labs-issue-review-actions">
        <div>
          <strong>{trainingCases.length} training · {holdoutCases.length} holdout · {deferred} deferred · {excluded} excluded</strong>
          <small>{reviewActionHint(review, next?.label ?? null, canQueue, trainingCases.length)}</small>
        </div>
        {review.status === "pending" ? (
          <button className="training-button" disabled={!complete || Boolean(training.busyAction)} type="button" onClick={() => void saveReview()}>
            {training.busyAction ? "Saving…" : "Save decisions"}
          </button>
        ) : review.status === "reviewed" ? (
          <button className="training-button" disabled={!canQueue || !trainingCases.length || Boolean(training.busyAction)} type="button" onClick={() => void queueReview()}>
            {training.busyAction ? "Queueing…" : `Queue ${review.passLabel} release`}
          </button>
        ) : (
          <button className="training-button secondary" type="button" onClick={() => onOpenSeries(series.id)}>Open comparison</button>
        )}
      </div>
    </div>
  );
}

function nextScheduledRelease(series: ModelComparisonSeries, entries: ModelComparisonSeriesEntry[]) {
  const existing = new Set(entries.map((entry) => entry.scheduleEntryId));
  return [...series.schedule]
    .sort((left, right) => left.ordinal - right.ordinal)
    .find((scheduled) => !existing.has(scheduled.id)) ?? null;
}

function scheduleOrdinal(series: ModelComparisonSeries, scheduleEntryId: string): number {
  return series.schedule.find((entry) => entry.id === scheduleEntryId)?.ordinal ?? Number.MAX_SAFE_INTEGER;
}

function taskIndex(state: TrainingStateResponse): Map<string, TaskDataRecord> {
  const result = new Map<string, TaskDataRecord>();
  for (const taskset of [...state.tasksets, ...state.modelTasksets]) {
    for (const task of taskset.tasks) result.set(task.id, task);
  }
  return result;
}

function taskPreview(task: TaskDataRecord): string {
  const raw = typeof task.input.prompt === "string" ? task.input.prompt : JSON.stringify(task.input);
  return raw.length > 190 ? `${raw.slice(0, 187)}…` : raw;
}

function releasePosition(review: ContinualBenchIssueReview): string {
  return review.status === "queued" ? "Materialized release" : "Later scheduled release";
}

function reviewActionHint(
  review: ContinualBenchIssueReview,
  nextLabel: string | null,
  canQueue: boolean,
  trainingCount: number,
): string {
  if (review.status === "queued") return `Queued as ${review.queuedEntry?.entryId ?? review.passLabel}. Starting training remains a separate action.`;
  if (review.status === "pending") return "Every issue needs a decision and a note before this review can be saved.";
  if (!trainingCount) return "At least one eligible training example must be included before queueing.";
  if (canQueue) return `${review.passLabel} is the next authorized release. Queueing will leave it ready and will not start a Run.`;
  return `This review is saved. It can be queued after ${nextLabel ?? "the preceding release"}.`;
}

function toEntryRef(entry: ModelComparisonSeriesEntry) {
  return {
    seriesId: entry.seriesId,
    entryId: entry.id,
    scheduleEntryId: entry.scheduleEntryId,
    ordinal: entry.ordinal,
    releaseHash: entry.releaseHash,
  };
}
