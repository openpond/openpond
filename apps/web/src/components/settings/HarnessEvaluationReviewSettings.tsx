import { useEffect, useState } from "react";
import type {
  HarnessEvaluationReviewCadence,
  HarnessEvaluationReviewReceipt,
  HarnessEvaluationReviewSchedule,
  HarnessRefinementCandidate,
  ModelImprovementQualificationReceipt,
} from "@openpond/contracts";

type Props = {
  backgroundReviewBusy: boolean;
  backgroundReviewEnabled: boolean;
  busy: boolean;
  reviews: HarnessEvaluationReviewReceipt[];
  candidates: HarnessRefinementCandidate[];
  qualifications: ModelImprovementQualificationReceipt[];
  schedule: HarnessEvaluationReviewSchedule;
  acceptingReviewId: string | null;
  onBackgroundReviewChange: (enabled: boolean) => void;
  onAcceptTasksetReview: (review: HarnessEvaluationReviewReceipt) => void;
  onReview: (maxEstimatedCostUsd: number) => void;
  onSaveSchedule: (input: {
    enabled: boolean;
    activityEnabled: boolean;
    activityBatchSize: number;
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
  candidates,
  qualifications,
  schedule,
  onReview,
  onSaveSchedule,
}: Props) {
  const [cadence, setCadence] = useState<HarnessEvaluationReviewCadence>(schedule.cadence);
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [activityEnabled, setActivityEnabled] = useState(schedule.activityEnabled);
  const [activityBatchSize, setActivityBatchSize] = useState(schedule.activityBatchSize);

  useEffect(() => {
    setCadence(schedule.cadence);
    setEnabled(schedule.enabled);
    setActivityEnabled(schedule.activityEnabled);
    setActivityBatchSize(schedule.activityBatchSize);
  }, [
    schedule.activityBatchSize,
    schedule.activityEnabled,
    schedule.cadence,
    schedule.enabled,
  ]);

  const dirty = cadence !== schedule.cadence
    || enabled !== schedule.enabled
    || activityEnabled !== schedule.activityEnabled
    || activityBatchSize !== schedule.activityBatchSize;

  return (
    <>
      <section className="harness-history-section">
        <div className="harness-section-heading">
          <div>
            <h2>Continuous learning</h2>
            <p>
              Review each completed turn, and separately look across Work for
              recurring evidence when you choose.
            </p>
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
                activityEnabled,
                activityBatchSize,
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
              <strong>Activity review</strong>
              <small>Review after a bounded batch of new outcomes. Unchanged evidence does not call the model.</small>
            </span>
            <span className="provider-toggle harness-learning-toggle">
              <input
                checked={activityEnabled}
                disabled={busy}
                onChange={(event) => setActivityEnabled(event.target.checked)}
                type="checkbox"
              />
              <span aria-hidden="true" />
            </span>
          </label>
          <div className="harness-learning-schedule">
            <label className="settings-select-field">
              <span>Activity batch</span>
              <select
                disabled={busy || !activityEnabled}
                onChange={(event) => setActivityBatchSize(Number(event.target.value))}
                value={activityBatchSize}
              >
                <option value={5}>5 new outcomes</option>
                <option value={10}>10 new outcomes</option>
                <option value={20}>20 new outcomes</option>
                <option value={50}>50 new outcomes</option>
              </select>
            </label>
          </div>
          <label className="harness-learning-setting">
            <span className="harness-learning-copy">
              <strong>Scheduled backstop</strong>
              <small>Optionally review daily or weekly when activity is low. This is the same cross-Work reviewer, not another learning loop.</small>
            </span>
            <span className="provider-toggle harness-learning-toggle">
              <input
                checked={enabled}
                disabled={busy}
                onChange={(event) => {
                  setEnabled(event.target.checked);
                  if (event.target.checked && cadence === "manual") setCadence("daily");
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
                disabled={busy || !enabled}
                onChange={(event) => {
                  const next = event.target.value as HarnessEvaluationReviewCadence;
                  setCadence(next);
                }}
                value={cadence === "manual" ? "daily" : cadence}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
          </div>
          <dl className="harness-learning-run-times">
            <div><dt>Last run</dt><dd>{formatDate(schedule.lastRunAt)}</dd></div>
            <div><dt>Next scheduled run</dt><dd>{schedule.enabled ? formatDate(schedule.nextRunAt) : "Off"}</dd></div>
            <div><dt>Activity trigger</dt><dd>{schedule.activityEnabled ? `${schedule.activityBatchSize} new outcomes` : "Off"}</dd></div>
          </dl>
        </section>
      </section>

      <section className="harness-history-section">
        <div className="harness-section-heading">
          <div>
            <h2>Cross-Work candidates</h2>
            <p>Persistent patterns carried across review windows until confirmed, resolved, rejected, or expired.</p>
          </div>
          <span>{candidates.length}</span>
        </div>
        {candidates.length ? candidates.map((candidate) => (
          <article
            className="harness-history-card harness-evaluation-review-card"
            key={`${candidate.id}:${candidate.contentHash}`}
          >
            <header>
              <div>
                <div className="harness-history-kicker">
                  <span className={`harness-status harness-status-${candidate.status}`}>
                    {displayClassification(candidate.status)}
                  </span>
                  <span>{candidate.occurrences.length} occurrences</span>
                </div>
                <h2>{candidate.statement}</h2>
              </div>
              <time>{formatDate(candidate.updatedAt)}</time>
            </header>
            <p>{candidate.resolution?.reason ?? candidate.recurrenceFamily}</p>
          </article>
        )) : <div className="harness-empty">No cross-Work candidates yet.</div>}
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
