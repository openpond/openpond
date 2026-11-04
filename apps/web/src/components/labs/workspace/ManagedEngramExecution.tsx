import { ManagedModificationPriceDetails, modificationSpendLabel, modificationStartLabel, modificationStartTerms } from "./ManagedModificationPrice";
import { ManagedEngramModelSave } from "../ManagedEngramModelSave";
import type { ManagedEngramExecution as Execution } from "openpond-sdk/training";
import type { WorkspaceApi } from "./workspace-api";
import { useState } from "react";
import { ErrorToast } from "../../common/ErrorToast";
import { AppDialog } from "../../dialogs/AppDialog";
import { EvaluationCard } from "./EvaluationPresentation";
import { EngramTrainingResult } from "./EngramTrainingResult";
import { useTrainingExperimentFunding } from "./useTrainingExperimentFunding";
import { TrainingExperimentFundingSummary } from "./TrainingExperimentFundingSummary";
import type { useManagedEngramExperiment } from "./useManagedEngramExperiment";

type Owner = ReturnType<typeof useManagedEngramExperiment>;
export function ManagedEngramExecution({ owner, api, onOpenBilling = null, billingReturnPending = false, onRefreshFunding, disabled = false }: {
  owner: Owner; api: WorkspaceApi; onOpenBilling?: (() => Promise<void>) | null;
  billingReturnPending?: boolean; onRefreshFunding?: () => Promise<void>; disabled?: boolean;
}) {
  const busy = owner.busy || disabled;
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
    value: Execution;
  } | null>(null);
  const funding = useTrainingExperimentFunding(api, metadata?.plan.maximumSpendUsd ?? "", Boolean(metadata), Boolean(metadata?.plan.computePrice));
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
          disabled={busy || owner.loading}
          onClick={owner.refresh}
        >
          Refresh execution and recovery
        </button>
        {retained ? (
          <button
            type="button"
            className="training-button"
            disabled={busy || !owner.recoveryReady}
            onClick={() => void owner.retry()}
          >
            {busy ? "Reconciling…" : `Retry original ${pendingAction}`}
          </button>
        ) : null}
      </div>
      {retained && !("action" in retained.command) ? (
        <EvaluationCard title="Original preparation">
          <p>
            {retained.command.name} · {retained.command.method} · {modificationSpendLabel(retained.command.maximumSpendUsd)}
          </p>
          <p>
            {retained.command.request.training.maxSteps} training steps ·{" "}
            batch {retained.command.request.data.batch.id} ·{" "}
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
            <dt>Runtime</dt>
            <dd className="saved-model-version-reference">{metadata.plan.runtimeHash}</dd>
          </dl>
          {value ? (
            <div className="model-build-actions">
              {value.phase === "prepared" ? (
                <button
                  type="button"
                  className="training-button"
                  disabled={
                    busy ||
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
                    busy ||
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
        <EngramTrainingResult result={value.result} />
      ) : metadata?.phase === "completed" ? (
        <p>
          No result bytes are available in this read. Retained execution identity remains available
          for recovery.
        </p>
      ) : null}

      {owner.selectedId ? <ManagedEngramModelSave key={`${api.key}:${owner.selectedId}`} api={api} id={owner.selectedId} execution={value} disabled={busy || Boolean(retained)} /> : null}
      {review && value ? (
        <AppDialog
          ariaLabel={
            review.action === "start"
              ? "Start Engram experiment"
              : "Cancel Engram experiment"
          }
          className="labs-rename-dialog"
          backdropClassName="labs-rename-backdrop"
          dismissDisabled={busy}
          onClose={() => {
            if (!busy) setReview(null);
          }}
        >
          <h2>
            {review.action === "start"
              ? "Start Engram experiment"
              : "Cancel Engram experiment"}
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
            <dt>Training steps</dt>
            <dd>{review.value.request.training.maxSteps}</dd>
            <dt>Reviewed batch</dt>
            <dd>{review.value.request.data.batch.id} · release {review.value.request.data.batch.revision}</dd>
            <dt>Maximum duration</dt>
            <dd>{review.value.request.training.maxDurationSeconds} seconds</dd>
            <dt>Model</dt>
            <dd>
              {review.value.request.model.modelId} · {review.value.request.model.revision}
            </dd>
            <dt>Plan</dt>
            <dd className="saved-model-version-reference">{review.value.plan.contentHash}</dd>
          </dl>
          <details><summary>Exact prepared training request</summary><pre>{JSON.stringify(review.value.request, null, 2)}</pre></details>
          {review.action === "start" ? <TrainingExperimentFundingSummary funding={funding} busy={busy} startAttempted={Boolean(retained)} billingReturnPending={billingReturnPending} onOpenBilling={onOpenBilling} onRefresh={onRefreshFunding ?? (async () => {await funding.refresh();})} /> : null}
          <div className="model-build-actions">
            <button
              type="button"
              className="training-button secondary"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              Close
            </button>
            <button
              type="button"
              className="training-button"
              disabled={
                busy ||
                owner.loading ||
                Boolean(retained) ||
                !owner.ready ||
                !owner.canControl ||
                (review.action === "start" && (billingReturnPending || !funding.canStart || Date.parse(review.value.plan.expiresAt) <= Date.now()))
              }
              onClick={() =>
                void owner.control(review.action, review.value).then((receipt) => {
                  if (receipt) setReview(null);
                })
              }
            >
              {busy
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
