import type { TrainingUsageQuote } from "openpond-sdk/training";

export function TrainingJudgeQuotePrices({ judges }: { judges: TrainingUsageQuote["judges"] }) {
  if (judges.prices.length === 0) return null;
  return (
    <details>
      <summary>Judge model rates</summary>
      <p>USD per million tokens, within the same spending limit.</p>
      {judges.prices.map((price) => (
        <div key={price.acceptedPricingHash}>
          <p>{price.displayName} ({price.modelId})</p>
          <ul>
            <li>Input: ${price.inputUsdPerMillionTokens}; cached input: ${price.cachedInputUsdPerMillionTokens}; output: ${price.outputUsdPerMillionTokens}.</li>
            {price.cacheWriteUsdPerMillionTokens !== null ? <li>Cache writes: ${price.cacheWriteUsdPerMillionTokens}.</li> : null}
            {price.cacheWriteOneHourUsdPerMillionTokens !== null ? <li>One-hour cache writes: ${price.cacheWriteOneHourUsdPerMillionTokens}.</li> : null}
            {price.longContext !== null ? (
              <li>
                Long context{price.longContextThresholdTokens !== null ? ` above ${price.longContextThresholdTokens.toLocaleString()} tokens` : ""}:
                {" "}input ${price.longContext.inputUsdPerMillionTokens}; cached input ${price.longContext.cachedInputUsdPerMillionTokens}; output ${price.longContext.outputUsdPerMillionTokens}.
                {price.longContext.cacheWriteUsdPerMillionTokens !== null ? ` Cache writes: $${price.longContext.cacheWriteUsdPerMillionTokens}.` : ""}
              </li>
            ) : null}
          </ul>
        </div>
      ))}
    </details>
  );
}
