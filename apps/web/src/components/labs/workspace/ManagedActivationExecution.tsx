import { ManagedModificationPriceDetails, modificationSpendLabel, modificationStartLabel, modificationStartTerms } from "./ManagedModificationPrice";
import { TrainSelectedNeurons } from "./TrainSelectedNeurons";
import type { ManagedModificationExecution } from "openpond-sdk/training";
import { ManagedSteeringModelSave } from "../ManagedSteeringModelSave";
import type { WorkspaceApi } from "./workspace-api";
import { useState } from "react";
import { ErrorToast } from "../../common/ErrorToast";
import { AppDialog } from "../../dialogs/AppDialog";
import { EvaluationCard } from "./EvaluationPresentation";
import { ActivationCaptureResult } from "./ActivationCaptureResult";
import type { useManagedActivationExperiment } from "./useManagedActivationExperiment";

type Owner = ReturnType<typeof useManagedActivationExperiment>;
export function ManagedActivationExecution({ owner, api }: { owner: Owner; api: WorkspaceApi }) {
  const value = owner.execution,
    retained = owner.original,
    metadata =
      (owner.receipt &&
      (!value ||
        (owner.receipt.execution.id === value.id &&
          owner.receipt.execution.revision > value.revision))
        ? owner.receipt.execution
        : value) ?? (retained && "execution" in retained.intent ? retained.intent.execution : null);
  const [review, setReview] = useState<{
    action: "start" | "cancel";
    value: ManagedModificationExecution;
  } | null>(null);
  const pendingAction = retained
    ? "action" in retained.command
      ? retained.command.action
      : "prepare"
    : null;
  return (
    <>
      <ErrorToast error={owner.error} />
      <div className="model-build-actions">
        <button
          type="button"
          className="training-button secondary"
          disabled={owner.busy || owner.loading}
          onClick={owner.refresh}
        >
          Refresh execution and recovery
        </button>
        {retained ? (
          <button
            type="button"
            className="training-button"
            disabled={owner.busy || !owner.recoveryReady}
            onClick={() => void owner.retry()}
          >
            {owner.busy ? "Reconciling…" : `Retry original ${pendingAction}`}
          </button>
        ) : null}
      </div>
      {retained && !("action" in retained.command) ? (
        <EvaluationCard title="Original preparation">
          <p>
            {retained.command.name} · {retained.command.method} · {modificationSpendLabel(retained.command.maximumSpendUsd)}
          </p>
          <p>
            {retained.command.request.prompts.length} prompts ·{" "}
            {retained.command.request.variants.length} variants ·{" "}
            {retained.command.request.model.modelId} · {retained.command.request.model.revision}
          </p>
        </EvaluationCard>
      ) : null}
      {metadata ? (
        <EvaluationCard title="Hosted execution">
          <dl className="evaluation-workspace-meta">
            <dt>State</dt>
            <dd>{metadata.phase}</dd>
            <dt>Maximum spend</dt>
            <dd>{modificationSpendLabel(metadata.plan.maximumSpendUsd)}</dd>
            <ManagedModificationPriceDetails price={metadata.plan.computePrice} />
            <dt>Execution</dt>
            <dd>{metadata.id}</dd>
            <dt>Preparation expires</dt>
            <dd>{new Date(metadata.plan.expiresAt).toLocaleString()}</dd>
            <dt>Exact plan</dt>
            <dd className="saved-model-version-reference">{metadata.plan.contentHash}</dd>
          </dl>
          {value ? (
            <div className="model-build-actions">
              {value.phase === "prepared" ? (
                <button
                  type="button"
                  className="training-button"
                  disabled={
                    owner.busy ||
                    owner.loading ||
                    !owner.ready ||
                    !owner.canControl ||
                    Boolean(retained) ||
                    Date.parse(value.plan.expiresAt) <= Date.now()
                  }
                  onClick={() => setReview({ action: "start", value })}
                >
                  Review Start
                </button>
              ) : null}
              {!["completed", "cancelled", "failed"].includes(value.phase) ? (
                <button
                  type="button"
                  className="training-button secondary"
                  disabled={
                    owner.busy ||
                    owner.loading ||
                    !owner.ready ||
                    !owner.canControl ||
                    Boolean(retained)
                  }
                  onClick={() => setReview({ action: "cancel", value })}
                >
                  Review Cancel
                </button>
              ) : null}
            </div>
          ) : null}
        </EvaluationCard>
      ) : null}
      {value?.result ? (
        <ActivationCaptureResult
          request={value.request}
          result={value.result}
          trainingAction={
            <TrainSelectedNeurons
              key={value.result.contentHash}
              execution={value}
              api={api}
              disabled={owner.busy || owner.loading || Boolean(retained)}
            />
          }
        />
      ) : metadata?.phase === "completed" ? (
        <p>
          No result bytes are available in this read. Retained execution identity remains available
          for recovery.
        </p>
      ) : null}
      {owner.selectedId ? (
        <ManagedSteeringModelSave
          key={`${api.key}:${owner.selectedId}`}
          api={api}
          id={owner.selectedId}
          execution={value}
          disabled={owner.busy || Boolean(retained)}
        />
      ) : null}
      {review && value ? (
        <AppDialog
          ariaLabel={
            review.action === "start"
              ? "Start activation experiment"
              : "Cancel activation experiment"
          }
          className="labs-rename-dialog"
          backdropClassName="labs-rename-backdrop"
          dismissDisabled={owner.busy}
          onClose={() => {
            if (!owner.busy) setReview(null);
          }}
        >
          <h2>
            {review.action === "start"
              ? "Start activation experiment"
              : "Cancel activation experiment"}
          </h2>
          <p>
            {review.action === "start"
              ? modificationStartTerms(review.value.plan.computePrice)
              : "Cancel this exact execution. In-flight work may need to stop and settle before capacity is released."}
          </p>
          <dl className="evaluation-workspace-meta">
            <dt>Maximum spend</dt>
            <dd>{modificationSpendLabel(review.value.plan.maximumSpendUsd)}</dd>
            <ManagedModificationPriceDetails price={review.value.plan.computePrice} />
            <dt>Prompts</dt>
            <dd>{review.value.request.prompts.length}</dd>
            <dt>Variants</dt>
            <dd>{review.value.request.variants.length}</dd>
            <dt>Model</dt>
            <dd>
              {review.value.request.model.modelId} · {review.value.request.model.revision}
            </dd>
            <dt>Plan</dt>
            <dd className="saved-model-version-reference">{review.value.plan.contentHash}</dd>
          </dl>
          <div className="model-build-actions">
            <button
              type="button"
              className="training-button secondary"
              disabled={owner.busy}
              onClick={() => setReview(null)}
            >
              Close
            </button>
            <button
              type="button"
              className="training-button"
              disabled={
                owner.busy ||
                owner.loading ||
                Boolean(retained) ||
                !owner.ready ||
                !owner.canControl
              }
              onClick={() =>
                void owner.control(review.action, review.value).then((receipt) => {
                  if (receipt) setReview(null);
                })
              }
            >
              {owner.busy
                ? "Applying…"
                : review.action === "start"
                  ? modificationStartLabel(review.value.plan.maximumSpendUsd)
                  : "Cancel execution"}
            </button>
          </div>
        </AppDialog>
      ) : null}
    </>
  );
}
