import type { TrainingGpuSelection } from "openpond-sdk/training";
import { Fragment, type ReactNode } from "react";
import { DropdownSelect } from "../../DropdownSelect";
import { ErrorToast } from "../../common/ErrorToast";
import { EvaluationCard } from "./EvaluationPresentation";
import type { useTrainingExperimentCompute } from "./useTrainingExperimentCompute";

type Compute = ReturnType<typeof useTrainingExperimentCompute>;
const usd = (value: number) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 4,
}).format(value);
const duration = (seconds: number) => seconds < 60 ? `${Math.ceil(seconds)} sec` : `${Math.ceil(seconds / 60)} min`;

export function TrainingExperimentComputeCard({ compute, selection, onChange, locked, method, budget, onBudgetChange,
  actualUsage, actualUsageAvailable, onBillingModeChange, customerCapUsd, onCustomerCapChange, prepared, startAttempted, busy, children }: {
  compute: Compute; selection: TrainingGpuSelection; onChange(value: TrainingGpuSelection): void;
  locked: boolean; method: "sft" | "grpo"; budget: string; onBudgetChange(value: string): void;
  actualUsage: boolean; customerCapUsd: string; onCustomerCapChange(value: string): void;
  actualUsageAvailable: boolean; onBillingModeChange(value: "prepaid_only" | "actual_usage"): void;
  prepared: boolean; startAttempted: boolean; busy: boolean;
  children?: ReactNode;
}) {
  const offers = compute.catalog.data?.offerings ?? [];
  const value = selection.mode === "automatic" ? `auto:${selection.objective}` : `offer:${selection.availabilityId}`;
  const selectedOffer = selection.mode === "manual" ? offers.find(offer => offer.availabilityId === selection.availabilityId) : null;
  const estimate = compute.estimate.data;
  return <EvaluationCard title="Compute and spending">
    <fieldset disabled={locked}>
      <label>GPUs
        <DropdownSelect label="GPU count" floating value={String(selection.gpuCount ?? 1)}
          options={[{ value: "1", label: "1 GPU" }, { value: "2", label: "2 GPUs", disabled: method !== "grpo" }]}
          onChange={count => onChange(selection.mode === "automatic"
            ? { ...selection, gpuCount: count === "2" ? 2 : 1 }
            : { mode: "automatic", objective: "balanced", gpuCount: count === "2" ? 2 : 1 })} />
      </label>
      <label>GPU
        <DropdownSelect label="GPU offering" floating searchable value={value}
          options={[
            { value: "auto:balanced", label: "Automatic · Balanced" },
            { value: "auto:economical", label: "Automatic · Lowest hourly cost" },
            { value: "auto:fast", label: "Automatic · Performance" },
            ...(selection.mode === "manual" && !selectedOffer ? [{ value, label: `${selection.gpuType} · Selected offering`, disabled: true }] : []),
            ...offers.map(offer => ({ value: `offer:${offer.availabilityId}`,
              label: `${offer.gpuType} · ${offer.hourlyUsd === null ? "Price unavailable" : `${usd(offer.hourlyUsd)}/hr`} · ${offer.dataCenterId ?? offer.region}`,
              disabled: offer.hourlyUsd === null || compute.catalogExpired || compute.catalog.isError })),
          ]}
          onChange={choice => {
            const offer = offers.find(item => `offer:${item.availabilityId}` === choice);
            if (offer) onChange({ mode: "manual", availabilityId: offer.availabilityId, gpuType: offer.gpuType,
              gpuCount: offer.gpuCount === 2 ? 2 : 1 });
            else if (["auto:balanced", "auto:economical", "auto:fast"].includes(choice))
              onChange({ mode: "automatic", objective: choice === "auto:fast" ? "fast" : choice === "auto:economical" ? "economical" : "balanced",
                gpuCount: selection.gpuCount ?? 1 });
          }} />
      </label>
      <label>Billing
        <DropdownSelect label="Training billing" floating value={actualUsage ? "actual_usage" : "prepaid_only"}
          options={[
            { value: "prepaid_only", label: "Reserved budget" },
            { value: "actual_usage", label: actualUsageAvailable ? "Actual usage" : "Actual usage · runtime qualification required", disabled: !actualUsageAvailable },
          ]}
          onChange={value => { if (value === "prepaid_only" || value === "actual_usage") onBillingModeChange(value); }} />
      </label>
      {actualUsage ? <label>Spending limit ($, optional)
        <input type="number" min="0.000001" max="1000000" step="any" value={customerCapUsd}
          placeholder="Use available credits" onChange={event => onCustomerCapChange(event.target.value)} />
      </label> : null}
      <label>{actualUsage ? "Planning budget ($)" : "Maximum spend ($)"}
        <input type="number" min="0.000001" max="1000000" step="any" value={budget}
          onChange={event => onBudgetChange(event.target.value)} />
      </label>
      {actualUsage ? <p>The planning budget configures the training plan. The optional spending limit above caps actual usage across all components.</p> : null}
    </fieldset>
    {!prepared ? <>
      {compute.catalog.isFetching ? <p role="status">Checking GPU availability…</p> : null}
      {compute.catalog.data && !compute.catalog.isError ? <p>
        {compute.catalogExpired ? "Availability needs refreshing." : `${offers.length} current offering${offers.length === 1 ? "" : "s"}.`}
      </p> : null}
      <button type="button" className="training-text-button" disabled={locked || !compute.query || compute.catalog.isFetching}
        onClick={() => void compute.catalog.refetch()}>Refresh availability</button>
    </> : <>
      {compute.estimate.isFetching ? <p role="status">Estimating this experiment…</p> : null}
      {estimate ? <>
        <dl className="training-compute-summary">
          <dt>Resolved GPU</dt><dd>{estimate.gpu.resolved
            ? `${estimate.gpu.resolved.gpuCount} × ${estimate.gpu.resolved.gpuType}` : "Unavailable"}</dd>
          <dt>Compute and disk</dt><dd>{estimate.gpu.hourlyUsd === null ? "Unknown" : `${usd(estimate.gpu.hourlyUsd)}/hr`}</dd>
          <dt>Execution time</dt><dd>{estimate.executionSeconds.expected === null ? "Unknown" : duration(estimate.executionSeconds.expected)}
            {estimate.executionSeconds.planningRange ? ` (${duration(estimate.executionSeconds.planningRange.low)}–${duration(estimate.executionSeconds.planningRange.high)} observed)` : ""}</dd>
          <dt>Expected total</dt><dd>{estimate.cost.expectedUsd === null ? "Unknown" : usd(estimate.cost.expectedUsd)}</dd>
          <dt>Cleanup reserve</dt><dd>{estimate.cost.minimumCleanupReserveUsd === null ? "Unknown" : usd(estimate.cost.minimumCleanupReserveUsd)}</dd>
        </dl>
        <p>{actualUsage ? "Review the component rates and whole-job spending limit before starting." : `The spending cap is ${usd(Number(budget))}.`} Hourly pricing is not an estimate of the total.</p>
        {compute.estimateExpired ? <p>Estimate expired. Refresh before starting.</p> : null}
        <details className="training-evidence"><summary>Estimate details</summary>
          <p>{estimate.calibration.completedSamples} matching completed run{estimate.calibration.completedSamples === 1 ? "" : "s"}. Queue wait is separate.</p>
          <p>Cost breakdown</p>
          <dl className="training-compute-summary">
            {estimate.cost.components.map(component => <Fragment key={`${component.phase}:${component.resource}`}>
              <dt>{component.phase.replaceAll("_", " ")} · {component.resource === "gpu" || component.resource === "cpu" ? component.resource.toUpperCase() : component.resource}</dt>
              <dd>
                {component.expectedUsd === null ? "Not yet estimated" : usd(component.expectedUsd)}
                {component.planningRangeUsd ? ` (${usd(component.planningRangeUsd.low)}–${usd(component.planningRangeUsd.high)} planning range)` : ""}
                {component.expectedSeconds !== null ? <p>{duration(component.expectedSeconds)} allocated resource time</p> : null}
                {component.reason ? <p>{component.reason}</p> : null}
              </dd>
            </Fragment>)}
          </dl>
          {estimate.unknowns.length ? <><p>Not yet estimated</p><ul>{estimate.unknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}</ul></> : null}
          {estimate.assumptions.length ? <><p>Assumptions</p><ul>{estimate.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul></> : null}
        </details>
      </> : null}
      <button type="button" className="training-text-button" disabled={busy || compute.estimate.isFetching || startAttempted}
        onClick={() => void compute.estimate.refetch()}>Refresh estimate</button>
    </>}
    {children}
    <ErrorToast error={prepared ? compute.estimate.error : compute.catalog.error} />
  </EvaluationCard>;
}
