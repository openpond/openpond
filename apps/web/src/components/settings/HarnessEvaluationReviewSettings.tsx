import { useEffect, useMemo, useState } from "react";
import type {
  HarnessEvaluationReviewCadence,
  HarnessEvaluationReviewReceipt,
  HarnessEvaluationReviewSchedule,
  ModelImprovementQualificationReceipt,
} from "@openpond/contracts";

type Props = {
  busy: boolean;
  reviews: HarnessEvaluationReviewReceipt[];
  qualifications: ModelImprovementQualificationReceipt[];
  schedule: HarnessEvaluationReviewSchedule;
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
  return value.replaceAll("_", " ");
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

function EvaluationReviewCard({ review }: { review: HarnessEvaluationReviewReceipt }) {
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
        <span><strong>${review.maxEstimatedCostUsd.toFixed(2)}</strong> maximum cost</span>
      </div>
      <ReviewLineage review={review} />
      <footer>
        <span>Watermark {formatDate(review.nextWatermark.throughCreatedAt)}</span>
        <code>{shortHash(review.nextWatermark.cursor)}</code>
      </footer>
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
        Review {shortHash(receipt.review.contentHash)} · Taskset {shortHash(receipt.tasksetRelease?.contentHash)} · Baseline {shortHash(receipt.baselineEvaluation?.contentHash)} · maximum ${receipt.maximumCostUsd.toFixed(2)}
      </small>
    </article>
  );
}

export function HarnessEvaluationReviewSettings({
  busy,
  reviews,
  qualifications,
  schedule,
  onReview,
  onSaveSchedule,
}: Props) {
  const [cadence, setCadence] = useState<HarnessEvaluationReviewCadence>(schedule.cadence);
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [cost, setCost] = useState(String(schedule.maxEstimatedCostUsd));

  useEffect(() => {
    setCadence(schedule.cadence);
    setEnabled(schedule.enabled);
    setCost(String(schedule.maxEstimatedCostUsd));
  }, [schedule]);

  const parsedCost = Number(cost);
  const validCost = Number.isFinite(parsedCost) && parsedCost >= 0;
  const latest = reviews[0] ?? null;
  const dirty = useMemo(
    () => cadence !== schedule.cadence ||
      enabled !== schedule.enabled ||
      (validCost && parsedCost !== schedule.maxEstimatedCostUsd),
    [cadence, enabled, parsedCost, schedule, validCost],
  );

  return (
    <>
      <section className="harness-history-section">
        <div className="harness-section-heading">
          <div>
            <h2>Model improvement review</h2>
            <p>Review authorized Harness evidence against a persisted watermark. This does not start training.</p>
          </div>
          <button
            className="settings-primary compact"
            disabled={busy || !validCost}
            onClick={() => onReview(parsedCost)}
            type="button"
          >
            {busy ? "Reviewing…" : "Review now"}
          </button>
        </div>

        <section className="account-list harness-review-controls">
          <div className="harness-review-control-grid">
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
            <label className="settings-select-field">
              <span>Maximum estimated cost (USD)</span>
              <input
                disabled={busy}
                min={0}
                onChange={(event) => setCost(event.target.value)}
                step="0.01"
                type="number"
                value={cost}
              />
            </label>
            <label className="harness-schedule-toggle">
              <span><strong>Scheduled review</strong><small>Uses the same review operation as Review now.</small></span>
              <span className="provider-toggle">
                <input
                  checked={enabled && cadence !== "manual"}
                  disabled={busy || cadence === "manual"}
                  onChange={(event) => setEnabled(event.target.checked)}
                  type="checkbox"
                />
                <span aria-hidden="true" />
              </span>
            </label>
            <button
              className="settings-secondary compact"
              disabled={busy || !dirty || !validCost}
              onClick={() => onSaveSchedule({ enabled, cadence, maxEstimatedCostUsd: parsedCost })}
              type="button"
            >
              Save schedule
            </button>
          </div>
          <div className="harness-review-status-grid">
            <div><span>Last result</span><strong>{latest ? displayClassification(latest.classification) : "No review"}</strong></div>
            <div><span>Last run</span><strong>{formatDate(schedule.lastRunAt)}</strong></div>
            <div><span>Next run</span><strong>{schedule.enabled ? formatDate(schedule.nextRunAt) : "Manual"}</strong></div>
            <div><span>Watermark</span><strong>{latest ? formatDate(latest.nextWatermark.throughCreatedAt) : "Not established"}</strong></div>
          </div>
          {schedule.lastError ? <p className="harness-review-error">Last scheduled run: {schedule.lastError}</p> : null}
        </section>
      </section>

      <section className="harness-history-section">
        <div className="harness-section-heading">
          <div><h2>Evaluation reviews</h2><p>Immutable review receipts and their downstream lineage.</p></div>
          <span>{reviews.length}</span>
        </div>
        {reviews.length
          ? reviews.map((review) => <EvaluationReviewCard key={`${review.id}:${review.contentHash}`} review={review} />)
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
