import type { TrainingUsageSnapshot } from "openpond-sdk/training";

const labels = { gpu: "Training compute", guest: "Training environments", storage: "Retained storage", judge: "Judge calls" };

export function TrainingUsageDetails({ usage }: { usage: TrainingUsageSnapshot }) {
  return (
    <section>
      <h3>Usage</h3>
      <p>Charged: ${usage.chargedUsd} · Committed: ${usage.committedUsd} · Pending: ${usage.outstandingUsd}</p>
      <p>{usage.customerCapUsd === null ? "Use available credits" : `$${usage.customerCapUsd} spending limit · $${usage.remainingCapUsd} remaining`}</p>
      <p>Current account credit available: ${usage.availableCreditUsd}.</p>
      <ul>
        {usage.components.map((component) => (
          <li key={component.component}>
            {labels[component.component]}: ${component.chargedUsd} charged; ${component.outstandingUsd} pending.
          </li>
        ))}
      </ul>
      <p>{usage.complete ? "All usage owners are closed." : "Usage is still being settled. Retained storage can continue after training stops."}</p>
      <small>As of {new Date(usage.asOf).toLocaleString()}</small>
    </section>
  );
}
