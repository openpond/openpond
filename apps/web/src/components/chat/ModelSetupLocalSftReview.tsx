import { useState } from "react";
import {
  LocalSftApprovalSchema,
  LocalSftReviewSchema,
  type LocalSftReviewRequest,
  type ResourceSetupDraft,
} from "@openpond/contracts/resource-setup";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { useErrorToast } from "../../app/AppToastContext";
import { ModelSetupLocalSftPreflight } from "./ModelSetupLocalSftPreflight";

type Approval = NonNullable<ResourceSetupDraft["localSftApproval"]>;
type Review = ReturnType<typeof LocalSftReviewSchema.parse>;
const pageSize = 10;

export function ModelSetupLocalSftReview({ connection, request, approval, busy, onBusy, onApprove }: {
  connection: ClientConnection;
  request: LocalSftReviewRequest;
  approval?: Approval;
  busy: boolean;
  onBusy(busy: boolean): void;
  onApprove(approval: Approval): void;
}) {
  const [review, setReview] = useState<Review>();
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState<"preview" | "approve" | null>(null);
  const [error, setError] = useState<unknown>(null);
  useErrorToast(error);

  async function previewOrApprove(expectedPlanHash?: string) {
    if (busy || pending) return;
    setPending(expectedPlanHash ? "approve" : "preview");
    setError(null);
    onBusy(true);
    try {
      if (expectedPlanHash) {
        const value = await apiFetch(connection, "/v1/training/local-sft/approve", {
          method: "POST", body: JSON.stringify({ request, expectedPlanHash }),
        });
        onApprove(LocalSftApprovalSchema.parse(value));
        setReview(undefined);
      } else {
        const value = await apiFetch(connection, "/v1/training/local-sft/preview", {
          method: "POST", body: JSON.stringify(request),
        });
        setReview(LocalSftReviewSchema.parse(value));
        setPage(0);
      }
    } catch (cause) { setError(cause); }
    finally { setPending(null); onBusy(false); }
  }

  const start = page * pageSize;
  const end = Math.min(start + pageSize, review?.rows.length ?? 0);
  return <div className="resource-setup-fields">
    {approval ? <div className="resource-setup-input">
      <strong>{approval.rowCount} {approval.rowCount === 1 ? "training example" : "training examples"} approved</strong>
      <span>{approval.datasetName} revision {approval.request.dataset.revision}</span>
      <small title={approval.planHash}>Review {approval.planHash.slice(0, 12)}</small>
      <ModelSetupLocalSftPreflight key={approval.planHash} approval={approval} connection={connection} busy={busy} onBusy={onBusy} />
    </div> : null}
    <button type="button" className="training-button secondary" disabled={busy || Boolean(pending)} onClick={() => void previewOrApprove()}>
      {pending === "preview" ? "Preparing review" : "Preview training examples"}
    </button>
    {review ? <>
      <div className="resource-setup-input">
        <strong>{review.plan.datasetName} revision {review.plan.request.dataset.revision}</strong>
        <span>{review.plan.rowCount} selected from {review.plan.eligibleRows} eligible train examples</span>
        {review.plan.excludedRows ? <span>{review.plan.excludedRows} ineligible train examples excluded</span> : null}
      </div>
      <ol start={start + 1} aria-label="Supervised examples">
        {review.rows.slice(start, end).map(row => <li key={row.id}>
          <strong>Prompt</strong><p>{row.prompt}</p>
          <strong>Expected answer</strong><p>{row.target}</p>
        </li>)}
      </ol>
      {review.rows.length > pageSize ? <div className="resource-setup-presets">
        <button type="button" className="training-button secondary" disabled={page === 0 || busy} onClick={() => setPage(page - 1)}>Previous examples</button>
        <span>{start + 1}–{end} of {review.rows.length}</span>
        <button type="button" className="training-button secondary" disabled={end === review.rows.length || busy} onClick={() => setPage(page + 1)}>Next examples</button>
      </div> : null}
      <button type="button" className="training-button" disabled={busy || Boolean(pending)} onClick={() => void previewOrApprove(review.plan.planHash)}>
        {pending === "approve" ? "Saving approval" : `Approve ${review.plan.rowCount} training ${review.plan.rowCount === 1 ? "example" : "examples"}`}
      </button>
    </> : null}
  </div>;
}
