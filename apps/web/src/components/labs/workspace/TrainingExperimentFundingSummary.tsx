import { ErrorToast } from "../../common/ErrorToast";
import type { useTrainingExperimentFunding } from "./useTrainingExperimentFunding";

const usd = (value: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Number(value));

export function TrainingExperimentFundingSummary({
  funding,
  busy,
  startAttempted,
  billingReturnPending,
  onOpenBilling,
  onRefresh,
}: {
  funding: ReturnType<typeof useTrainingExperimentFunding>;
  busy: boolean;
  startAttempted: boolean;
  billingReturnPending: boolean;
  onOpenBilling: (() => Promise<void>) | null;
  onRefresh(): Promise<void>;
}) {
  const value = funding.query.data;
  if (funding.allocationAdmission)
    return (
      <>
        <p>
          Credits are checked when compute is allocated. An optional spending limit caps total
          usage; it does not reserve that amount.
        </p>
        {billingReturnPending ? (
          <>
            <p>Your experiment is saved. Return from Billing to review it before starting.</p>
            <button
              type="button"
              className="training-text-button"
              disabled={busy || startAttempted}
              onClick={() => void onRefresh()}
            >
              Return from Billing
            </button>
          </>
        ) : null}
        {onOpenBilling ? (
          <button
            type="button"
            className="training-text-button"
            disabled={busy || startAttempted || !funding.valid}
            onClick={() => void onOpenBilling()}
          >
            Add credits
          </button>
        ) : null}
      </>
    );
  return (
    <>
      {funding.query.isFetching ? <p role="status">Checking credits…</p> : null}
      {value && !funding.query.isError ? (
        <>
          {value.availableUsageUsd !== null ? (
            <dl className="training-compute-summary">
              <dt>Available usage</dt>
              <dd>{usd(value.availableUsageUsd)}</dd>
            </dl>
          ) : null}
          <p>
            {funding.expired
              ? "Refresh credits before starting."
              : {
                  covered: "Current credits cover this spending cap.",
                  insufficient_credit: "More credits are needed to cover this spending cap.",
                  member_limit: "This cap exceeds your workspace member spending limit.",
                  unavailable: "Workspace funding is unavailable for this cap.",
                }[value.state]}
          </p>
          {!value.canPurchase && value.state === "insufficient_credit" ? (
            <p>A workspace billing owner can add credits.</p>
          ) : null}
        </>
      ) : null}
      {billingReturnPending ? (
        <p>
          Your experiment is saved. Finish in Billing, then return here to refresh credits and
          review the estimate.
        </p>
      ) : null}
      <button
        type="button"
        className="training-text-button"
        disabled={busy || startAttempted || !funding.valid || funding.query.isFetching}
        onClick={() => void onRefresh()}
      >
        Refresh credits
      </button>
      {onOpenBilling && value?.canPurchase ? (
        <button
          type="button"
          className="training-text-button"
          disabled={busy || startAttempted || !funding.valid}
          onClick={() => void onOpenBilling()}
        >
          Add credits
        </button>
      ) : null}
      <ErrorToast error={funding.query.error} />
    </>
  );
}
