import type {
  HarnessEvaluationReviewReceipt,
  HarnessEvaluationReviewSchedule,
  HarnessRefinementCandidate,
  ModelImprovementQualificationReceipt,
} from "@openpond/contracts";

type Props = {
  acceptingReviewId: string | null;
  busy: boolean;
  candidates: HarnessRefinementCandidate[];
  qualifications: ModelImprovementQualificationReceipt[];
  reviews: HarnessEvaluationReviewReceipt[];
  schedule: HarnessEvaluationReviewSchedule;
  onAcceptTasksetReview: (review: HarnessEvaluationReviewReceipt) => void;
  onReview: (maxEstimatedCostUsd: number) => void;
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

function displayCandidateStatus(value: HarnessRefinementCandidate["status"]): string {
  if (value === "unresolved") return "Watching";
  if (value === "confirmed") return "Ready for Refiner";
  return displayClassification(value);
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

function CandidateDisclosure({ candidate }: { candidate: HarnessRefinementCandidate }) {
  return (
    <details className="harness-disclosure-row">
      <summary>
        <span className={`harness-status harness-status-${candidate.status}`}>
          {displayCandidateStatus(candidate.status)}
        </span>
        <strong>{candidate.statement}</strong>
        <small>{candidate.occurrences.length} occurrence{candidate.occurrences.length === 1 ? "" : "s"}</small>
        <time>{formatDate(candidate.updatedAt)}</time>
      </summary>
      <div className="harness-disclosure-body">
        <p>{candidate.resolution?.reason ?? candidate.recurrenceFamily}</p>
        <dl className="harness-compact-metadata">
          <div><dt>Pattern</dt><dd>{candidate.recurrenceFamily}</dd></div>
          <div><dt>Fingerprint</dt><dd><code>{shortHash(candidate.fingerprint)}</code></dd></div>
        </dl>
        {candidate.occurrences.length ? (
          <details className="harness-history-details">
            <summary>Evidence receipts</summary>
            <ul className="harness-evidence-list">
              {candidate.occurrences.map((occurrence) => (
                <li key={`${occurrence.evidence.id}:${occurrence.evidence.contentHash}`}>
                  <span>{displayClassification(occurrence.kind)}</span>
                  <code>{shortHash(occurrence.evidence.contentHash)}</code>
                  <time>{formatDate(occurrence.occurredAt)}</time>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </details>
  );
}

function EvaluationReviewDisclosure({
  accepting,
  onAcceptTasksetReview,
  review,
}: {
  accepting: boolean;
  onAcceptTasksetReview: (review: HarnessEvaluationReviewReceipt) => void;
  review: HarnessEvaluationReviewReceipt;
}) {
  const awaitingTasksetApproval = review.classification === "taskset"
    && review.nextAuthority === "human_review"
    && review.tasksetProposal === null;
  return (
    <details className="harness-disclosure-row">
      <summary>
        <span className={`harness-status harness-status-${review.classification}`}>
          {displayClassification(review.classification)}
        </span>
        <strong>{review.claim?.statement ?? review.reason}</strong>
        <small>{review.selectedEvidence.length} selected</small>
        <time>{formatDate(review.createdAt)}</time>
      </summary>
      <div className="harness-disclosure-body">
        <p>{review.reason}</p>
        <div className="harness-review-metrics">
          <span><strong>{review.selectedEvidence.length}</strong> selected</span>
          <span><strong>{review.excludedEvidence.length}</strong> excluded</span>
          <span><strong>{review.claim?.independentOccurrences ?? 0}</strong> independent occurrences</span>
          <span>Next: <strong>{displayClassification(review.nextAuthority)}</strong></span>
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
      </div>
    </details>
  );
}

function QualificationDisclosure({ receipt }: { receipt: ModelImprovementQualificationReceipt }) {
  return (
    <details className="harness-disclosure-row">
      <summary>
        <span className={`harness-status harness-status-${receipt.decision}`}>
          {displayClassification(receipt.decision)}
        </span>
        <strong>{receipt.model.provider}/{receipt.model.model}</strong>
        <small>{displayClassification(receipt.signal.strength)} signal</small>
        <time>{formatDate(receipt.createdAt)}</time>
      </summary>
      <div className="harness-disclosure-body">
        <p>{receipt.reasons.join(" ")}</p>
        <dl className="harness-compact-metadata">
          <div><dt>Review</dt><dd><code>{shortHash(receipt.review.contentHash)}</code></dd></div>
          <div><dt>Taskset</dt><dd><code>{shortHash(receipt.tasksetRelease?.contentHash)}</code></dd></div>
          <div><dt>Baseline</dt><dd><code>{shortHash(receipt.baselineEvaluation?.contentHash)}</code></dd></div>
        </dl>
      </div>
    </details>
  );
}

export function HarnessEvaluationReviewSettings({
  acceptingReviewId,
  busy,
  candidates,
  onAcceptTasksetReview,
  onReview,
  qualifications,
  reviews,
  schedule,
}: Props) {
  const continuousEnabled = schedule.activityEnabled || schedule.enabled;
  return (
    <div className="harness-page-sections">
      <section className="harness-history-section" aria-label="Continuous Review status">
        <div className="harness-table-wrap">
          <table className="harness-table harness-review-status-table">
            <thead><tr><th>Status</th><th>Trigger</th><th>Last review</th><th>Last result</th></tr></thead>
            <tbody><tr><td><span className={`harness-status ${continuousEnabled ? "harness-status-advanced" : ""}`}>{continuousEnabled ? "On" : "Off"}</span></td><td>{schedule.activityEnabled ? `${schedule.activityBatchSize} new outcomes` : "Manual only"}</td><td>{formatDate(schedule.lastRunAt)}</td><td>{schedule.lastResult ? displayClassification(schedule.lastResult.classification) : "No completed review"}</td></tr></tbody>
          </table>
        </div>
      </section>

      <div className="harness-page-action-row">
        <p>Review new evidence now with the current cost limit of ${schedule.maxEstimatedCostUsd.toFixed(2)}.</p>
        <button className="settings-primary compact" disabled={busy} onClick={() => onReview(schedule.maxEstimatedCostUsd)} type="button">
          {busy ? "Reviewing…" : "Review now"}
        </button>
      </div>

      <section className="harness-history-section">
        <div className="harness-section-heading">
          <div><h2>Patterns</h2><p>Recurring evidence being watched or ready for the Refiner.</p></div>
          <span>{candidates.length}</span>
        </div>
        <div className="harness-disclosure-list">
          {candidates.length
            ? candidates.map((candidate) => <CandidateDisclosure candidate={candidate} key={`${candidate.id}:${candidate.contentHash}`} />)
            : <div className="harness-empty compact">No recurring patterns are being tracked.</div>}
        </div>
      </section>

      <section className="harness-history-section">
        <div className="harness-section-heading">
          <div><h2>Review history</h2><p>Receipts stay compact; expand one for evidence and downstream lineage.</p></div>
          <span>{reviews.length}</span>
        </div>
        <div className="harness-disclosure-list">
          {reviews.length
            ? reviews.map((review) => (
                <EvaluationReviewDisclosure
                  accepting={acceptingReviewId === review.id}
                  key={`${review.id}:${review.contentHash}`}
                  onAcceptTasksetReview={onAcceptTasksetReview}
                  review={review}
                />
              ))
            : <div className="harness-empty compact">No Continuous Review receipts yet.</div>}
        </div>
      </section>

      {qualifications.length ? (
        <section className="harness-history-section">
          <div className="harness-section-heading">
            <div><h2>Training handoffs</h2><p>Evidence-bound qualification receipts created for Models.</p></div>
            <span>{qualifications.length}</span>
          </div>
          <div className="harness-disclosure-list">
            {qualifications.map((receipt) => <QualificationDisclosure key={`${receipt.id}:${receipt.contentHash}`} receipt={receipt} />)}
          </div>
        </section>
      ) : null}
    </div>
  );
}
