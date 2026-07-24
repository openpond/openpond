import type { TrainingPreparedStart } from "@openpond/contracts";
import type { ReactNode } from "react";

import { X } from "../icons";
import {
  destinationLabel,
  formatBytes,
  modelLabel,
  type PortableTrainingMethod,
} from "./training-start-view-helpers";

export function TrainingProviderApprovalDialog({
  open,
  busy,
  destinationId,
  baseModelId,
  method,
  rftBaselineReady,
  baselineBusy,
  baselineActionLabel,
  baselineActionAvailable,
  onRunBaseline,
  approvalFields,
  prepared,
  preparedQuote,
  compatible,
  actionLabel,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  destinationId: string;
  baseModelId: string;
  method: PortableTrainingMethod;
  rftBaselineReady: boolean;
  baselineBusy: boolean;
  baselineActionLabel: string;
  baselineActionAvailable: boolean;
  onRunBaseline: () => void;
  approvalFields: ReactNode;
  prepared: TrainingPreparedStart | null;
  preparedQuote: number | null;
  compatible: boolean;
  actionLabel: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="training-dialog-backdrop"
      role="presentation"
      onMouseDown={busy ? undefined : onClose}
    >
      <section
        aria-label="Review provider approval"
        aria-modal="true"
        className="training-dialog training-provider-approval-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="training-dialog-header">
          <div>
            <h2>Review and run</h2>
            <p>
              {destinationLabel(destinationId)} · {modelLabel(baseModelId)}
            </p>
          </div>
          <button
            aria-label="Close provider approval"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        {method === "grpo" ? (
          <section className="training-launch-check">
            <div>
              <strong>
                {rftBaselineReady
                  ? "Train signal verified"
                  : "Train-signal check required"}
              </strong>
              <span>
                {rftBaselineReady
                  ? "The selected prompts produced the mixed rewards required for GRPO."
                  : "Run the selected train prompts before any provider upload or paid training job can start."}
              </span>
            </div>
            {!rftBaselineReady ? (
              <button
                className="training-button secondary"
                type="button"
                disabled={
                  baselineBusy || !baseModelId || !baselineActionAvailable
                }
                onClick={onRunBaseline}
              >
                {baselineActionLabel}
              </button>
            ) : null}
          </section>
        ) : null}
        {approvalFields}
        {prepared ? (
          <dl className="training-start-summary">
            <div>
              <dt>Exact quote</dt>
              <dd>
                {preparedQuote == null
                  ? "Unavailable"
                  : `$${preparedQuote.toFixed(2)}`}
              </dd>
            </div>
            <div>
              <dt>Prepared data</dt>
              <dd>
                {formatBytes(prepared.bundle.totalSizeBytes)} · verified
              </dd>
            </div>
          </dl>
        ) : null}
        <div className="training-dialog-actions">
          <button
            className="training-button secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="training-button"
            type="button"
            disabled={busy || !compatible}
            onClick={onConfirm}
          >
            {actionLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
