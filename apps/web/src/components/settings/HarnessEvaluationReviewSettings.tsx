import { useEffect, useState } from "react";
import type {
  HarnessEvaluationReviewCadence,
  HarnessEvaluationReviewReceipt,
  HarnessEvaluationReviewSchedule,
  ModelImprovementQualificationReceipt,
} from "@openpond/contracts";

type Props = {
  backgroundReviewBusy: boolean;
  backgroundReviewEnabled: boolean;
  busy: boolean;
  reviews: HarnessEvaluationReviewReceipt[];
  qualifications: ModelImprovementQualificationReceipt[];
  schedule: HarnessEvaluationReviewSchedule;
  acceptingReviewId: string | null;
  onBackgroundReviewChange: (enabled: boolean) => void;
  onAcceptTasksetReview: (review: HarnessEvaluationReviewReceipt) => void;
  onReview: (maxEstimatedCostUsd: number) => void;
  onSaveSchedule: (input: {
    enabled: boolean;
    cadence: HarnessEvaluationReviewCadence;
    maxEstimatedCostUsd: number;
  }) => void;
};

function formatDate(value: string | null): string {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function shortHash(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "none";
}

function displayClassification(value: string): string {
  const label = value.replaceAll("_", " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function ReviewLineage({ review }: { review: HarnessEvaluationReviewReceipt }) {
  const refs = [
    ["Taskset", review.tasksetProposal],
    ["Baseline evaluation", review.evaluation],
    ["Training qualification", review.trainingQualification],
  ] as const;
  return (
    <div className="harness-review-lineage" aria-label="Review lineage">
      {refs.map(([label, reference]) => (
        <div className={reference ? "linked" : "pending"} key={label}>
          <span>{label}</span>
          <code>{reference ? shortHash(reference.contentHash) : "Not created"}</code>
        </div>
      ))}
    </div>
  );
}

function EvaluationReviewCard({
  accepting,
  onAcceptTasksetReview,
  review,
}: {
  accepting: boolean;
  onAcceptTasksetReview: (review: HarnessEvaluationReviewReceipt) => void;
  review: HarnessEvaluationReviewReceipt;
}) {
  const awaitingTasksetApproval =
    review.classification === "taskset" &&
    review.nextAuthority === "human_review" &&
    review.tasksetProposal === null;
  return (
    <article className="harness-history-card harness-evaluation-review-card">
      <header>
        <div>
          <div className="harness-history-kicker">
            <span className={`harness-status harness-status-${review.classification}`}>
              {displayClassification(review.classification)}
            </span>
            <span>{displayClassification(review.nextAuthority)}</span>
          </div>
          <h2>{review.claim?.statement ?? review.reason}</h2>
        </div>
        <time>{formatDate(review.createdAt)}</time>
      </header>
      <p>{review.reason}</p>
      <div className="harness-review-metrics">
        <span><strong>{review.selectedEvidence.length}</strong> selected</span>
        <span><strong>{review.excludedEvidence.length}</strong> excluded</span>
        <span><strong>{review.claim?.independentOccurrences ?? 0}</strong> independent occurrences</span>
      </div>
      <ReviewLineage review={review} />
      {awaitingTasksetApproval ? (
        <div className="harness-history-actions">
          <button
            className="settings-primary compact"
            disabled={accepting}
            onClick={() => onAcceptTasksetReview(review)}
            type="button"
          >
            {accepting ? "Opening Taskset review…" : "Build training Taskset"}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function QualificationCard({ receipt }: { receipt: ModelImprovementQualificationReceipt }) {
  return (
    <article className="harness-route-card harness-qualification-card">
      <div>
        <span className={`harness-status harness-status-${receipt.decision}`}>
          {displayClassification(receipt.decision)}
        </span>
        <strong>{receipt.model.provider}/{receipt.model.model}</strong>
        <time>{formatDate(receipt.createdAt)}</time>
      </div>
      <p>{receipt.reasons.join(" ")}</p>
      <small>
        Review {shortHash(receipt.review.contentHash)} · Taskset {shortHash(receipt.tasksetRelease?.contentHash)} · Baseline {shortHash(receipt.baselineEvaluation?.contentHash)}
      </small>
    </article>
  );
}

export function HarnessEvaluationReviewSettings({
  acceptingReviewId,
  backgroundReviewBusy,
  backgroundReviewEnabled,
  busy,
  onBackgroundReviewChange,
  onAcceptTasksetReview,
  reviews,
  qualifications,
  schedule,
  onReview,
  onSaveSchedule,
}: Props) {
  const [cadence, setCadence] = useState<HarnessEvaluationReviewCadence>(schedule.cadence);
  const [enabled, setEnabled] = useState(schedule.enabled);

  useEffect(() => {
    setCadence(schedule.cadence);
    setEnabled(schedule.enabled);
  }, [schedule.cadence, schedule.enabled]);

  const dirty = cadence !== schedule.cadence || enabled !== schedule.enabled;

  return (
    <>
      <section className="harness-history-section">
        <div className="harness-section-heading">
          <div>
            <h2>Continuous learning</h2>
            <p>Review completed turns immediately, then run scheduled RL reviews across recurring evidence. Neither process starts training or activates a Model.</p>
          </div>
          <div className="harness-section-actions">
            <button
              className="settings-secondary compact"
              disabled={busy}
              onClick={() => onReview(schedule.maxEstimatedCostUsd)}
              type="button"
            >
              Review now
            </button>
            <button
              className="settings-primary compact"
              disabled={busy || !dirty}
              onClick={() => onSaveSchedule({
                enabled,
                cadence,
                maxEstimatedCostUsd: schedule.maxEstimatedCostUsd,
              })}
              type="button"
            >
              Update schedule
            </button>
          </div>
        </div>

        <section className="harness-learning-card" aria-label="Continuous learning controls">
          <label className="harness-learning-setting">
            <span className="harness-learning-copy">
              <strong>Refiner</strong>
              <small>Review each completed turn for reusable improvements. This is enabled by default for new users.</small>
            </span>
            <span className="provider-toggle harness-learning-toggle">
              <input
                checked={backgroundReviewEnabled}
                disabled={backgroundReviewBusy}
                onChange={(event) => onBackgroundReviewChange(event.target.checked)}
                type="checkbox"
              />
              <span aria-hidden="true" />
            </span>
          </label>
          <label className="harness-learning-setting">
            <span className="harness-learning-copy">
              <strong>RL review</strong>
              <small>Compare recurring evidence on a schedule and propose evaluation or training work. Unchanged evidence does not call the model.</small>
            </span>
            <span className="provider-toggle harness-learning-toggle">
              <input
                checked={enabled}
                disabled={busy}
                onChange={(event) => {
                  const nextEnabled = event.target.checked;
                  const nextCadence = nextEnabled && cadence === "manual" ? "daily" : cadence;
                  setEnabled(nextEnabled);
                  setCadence(nextCadence);
                }}
                type="checkbox"
              />
              <span aria-hidden="true" />
            </span>
          </label>
          <div className="harness-learning-schedule">
            <label className="settings-select-field">
              <span>Cadence</span>
              <select
                disabled={busy}
                onChange={(event) => {
                  const next = event.target.value as HarnessEvaluationReviewCadence;
                  setCadence(next);
                  if (next === "manual") setEnabled(false);
                }}
                value={cadence}
              >
                <option value="manual">Manual only</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
          </div>
          <dl className="harness-learning-run-times">
            <div><dt>Last run</dt><dd>{formatDate(schedule.lastRunAt)}</dd></div>
            <div><dt>Next run</dt><dd>{schedule.enabled ? formatDate(schedule.nextRunAt) : "Manual"}</dd></div>
          </dl>
        </section>
      </section>

      <section className="harness-history-section">
        <div className="harness-section-heading">
          <div><h2>Evaluation reviews</h2><p>Immutable review receipts and their downstream lineage.</p></div>
          <span>{reviews.length}</span>
        </div>
        {reviews.length
          ? reviews.map((review) => (
              <EvaluationReviewCard
                accepting={acceptingReviewId === review.id}
                key={`${review.id}:${review.contentHash}`}
                onAcceptTasksetReview={onAcceptTasksetReview}
                review={review}
              />
            ))
          : <div className="harness-empty">No model improvement reviews have run.</div>}
      </section>

      <section className="harness-history-section">
        <div className="harness-section-heading">
          <div><h2>Training qualifications</h2><p>Evidence-bound decisions that permit a specific training method or record why training is not warranted.</p></div>
          <span>{qualifications.length}</span>
        </div>
        {qualifications.length
          ? qualifications.map((receipt) => <QualificationCard key={`${receipt.id}:${receipt.contentHash}`} receipt={receipt} />)
          : <div className="harness-empty">No review has reached training qualification.</div>}
      </section>
    </>
  );
}
