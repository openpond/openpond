import {
  hostedUsageCostUsd,
  type HostedTokenPricing,
} from "./hosted-token-pricing.js";

export function hostedModelJudgeCallCost(input: {
  costUsd?: unknown;
  usage?: unknown;
  pricing?: HostedTokenPricing;
}): number | null {
  if (
    typeof input.costUsd === "number"
    && Number.isFinite(input.costUsd)
    && input.costUsd >= 0
  ) {
    return input.costUsd;
  }
  if (!input.pricing) return null;
  const usages = Array.isArray(input.usage)
    ? input.usage
    : input.usage === undefined
      ? []
      : [input.usage];
  const costs = usages.map((usage) => hostedUsageCostUsd(usage, input.pricing!));
  if (!costs.length || !costs.every((cost): cost is number => cost !== null)) {
    return null;
  }
  return costs.reduce((total, cost) => total + cost, 0);
}
