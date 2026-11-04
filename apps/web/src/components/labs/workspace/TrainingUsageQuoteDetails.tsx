import type { TrainingUsageQuote } from "openpond-sdk/training";
import { TrainingJudgeQuotePrices } from "./TrainingJudgeQuotePrices";

/** The reviewed price is display data; rendering never starts or funds work. */
export function TrainingUsageQuoteDetails({ quote }: { quote: TrainingUsageQuote }) {
  return (
    <>
      <p>
        {quote.customerCapUsd === null
          ? "Use available credits"
          : `$${quote.customerCapUsd} total spending limit`}
      </p>
      <ul>
        <li>Training compute: ${quote.gpu.hourlyUsd}/hour, including startup.</li>
        {quote.guests.map((guest) => (
          <li key={guest.profileHash}>
            Training environment ({guest.resources.cpu} CPU, {guest.resources.memoryGb} GiB memory):
            {" "}${guest.price.hourlyUsd}/hour while active.
          </li>
        ))}
        <li>Retained objects: ${quote.storage.price.hourlyUsd}/GiB-hour during training and through {quote.retentionDays} days after its accepted execution deadline.</li>
        {quote.judges.prices.length > 0 ? <li>Judge calls use the model rates below.</li> : null}
      </ul>
      <TrainingJudgeQuotePrices judges={quote.judges} />
      <p>Stopped training compute has no warm-idle charge. Retained storage is billed separately within the same spending limit; running out of credit does not delete saved objects.</p>
    </>
  );
}
