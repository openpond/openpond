import { normalizeModelUsageTokens } from "../runtime/model-usage-normalization.js";
import {
  hostedTokenPricingFromCatalog,
  type HostedTokenPricing,
} from "./hosted-token-pricing.js";

export type RfqHostedModelChargeQuote = {
  pricing: HostedTokenPricing;
  gatewayRateCardVersion: "gateway_retail_2026_09_27";
  maximumInputRateUsdPerMillion: number;
  maximumOutputRateUsdPerMillion: number;
  maximumInputTokens: number;
  maximumOutputTokens: number;
  maximumCents: number;
};

/** Price a single bounded hosted request, including an independently admitted
 * tool-loop, overflow-retry, or compaction request. The caller must prove that
 * the provider enforces both token limits before using this for paid dispatch.
 */
export function quoteRfqHostedModelRequest(input: {
  modelCatalogRaw: Record<string, unknown>;
  maximumInputTokens: number;
  maximumOutputTokens: number;
}): RfqHostedModelChargeQuote {
  const maximumInputTokens = positiveInteger(input.maximumInputTokens, "input token ceiling");
  const maximumOutputTokens = positiveInteger(input.maximumOutputTokens, "output token ceiling");
  const pricing = hostedTokenPricingFromCatalog(input.modelCatalogRaw);
  const rawPricing = record(record(record(input.modelCatalogRaw.metadata)?.billing)?.pricing) ?? {};
  const longContext = rawPricing.longContextPricing === undefined
    ? null : record(rawPricing.longContextPricing);
  if (rawPricing.longContextPricing !== undefined && !longContext) {
    throw new Error("RFQ hosted model long-context pricing is invalid.");
  }
  if (longContext) {
    requiredRate(longContext.inputUsdPerMillionTokens);
    requiredRate(longContext.cachedInputUsdPerMillionTokens);
    requiredRate(longContext.outputUsdPerMillionTokens);
  }
  const maximumInputRateUsdPerMillion = Math.max(
    pricing.inputUsdPerMillionTokens,
    pricing.cachedInputUsdPerMillionTokens,
    optionalRate(rawPricing.cacheWriteUsdPerMillionTokens),
    optionalRate(rawPricing.cacheWriteOneHourUsdPerMillionTokens),
    optionalRate(longContext?.inputUsdPerMillionTokens),
    optionalRate(longContext?.cachedInputUsdPerMillionTokens),
    optionalRate(longContext?.cacheWriteUsdPerMillionTokens),
  );
  const maximumOutputRateUsdPerMillion = Math.max(
    pricing.outputUsdPerMillionTokens,
    optionalRate(longContext?.outputUsdPerMillionTokens),
  );
  const maximumCents = ceilCents(
    retailUpperUsd((maximumInputTokens * maximumInputRateUsdPerMillion
      + maximumOutputTokens * maximumOutputRateUsdPerMillion) / 1_000_000),
  );
  if (maximumCents === 0) throw new Error("RFQ hosted model price has no positive bounded reservation.");
  return { pricing, gatewayRateCardVersion: "gateway_retail_2026_09_27",
    maximumInputRateUsdPerMillion, maximumOutputRateUsdPerMillion,
    maximumInputTokens, maximumOutputTokens, maximumCents };
}

/** A null result means the provider usage is incomplete: retain the full
 * reservation. Never infer a zero charge from an absent or partial receipt.
 */
export function settleRfqHostedModelCharge(
  quote: RfqHostedModelChargeQuote,
  usage: unknown,
): number | null {
  const tokens = normalizeModelUsageTokens(usage);
  if (tokens.promptTokens === null || tokens.completionTokens === null) return null;
  const cached = tokens.cachedPromptTokens ?? 0;
  const uncached = tokens.uncachedPromptTokens ?? tokens.promptTokens - cached;
  if (!nonnegativeInteger(tokens.promptTokens) || !nonnegativeInteger(tokens.completionTokens)
    || !nonnegativeInteger(cached) || !nonnegativeInteger(uncached)
    || cached + uncached !== tokens.promptTokens
    || tokens.promptTokens > quote.maximumInputTokens
    || tokens.completionTokens > quote.maximumOutputTokens) {
    throw new Error("RFQ hosted model usage is inconsistent with its admitted request ceiling.");
  }
  // This is a conservative retail charge, not the authoritative billing
  // settlement. Only the Sandbox gateway's independently verified meter may
  // release unused reservation to the experiment ledger.
  const cents = ceilCents(retailUpperUsd((tokens.promptTokens * quote.maximumInputRateUsdPerMillion
    + tokens.completionTokens * quote.maximumOutputRateUsdPerMillion) / 1_000_000));
  if (cents > quote.maximumCents) throw new Error("RFQ hosted model charge exceeds its reservation.");
  return cents;
}

function ceilCents(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("RFQ hosted model price is invalid.");
  const cents = Math.ceil(usd * 100 - 1e-12);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("RFQ hosted model charge is invalid.");
  return cents;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`RFQ ${name} must be a positive integer.`);
  return value;
}

function nonnegativeInteger(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function optionalRate(value: unknown): number {
  if (value === undefined) return 0;
  return requiredRate(value);
}

function requiredRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("RFQ hosted model catalog has an invalid optional token rate.");
  }
  return value;
}

function retailUpperUsd(providerUsd: number): number {
  // Sandbox gateway-rate-card.ts uses a 25% gross margin and micro-USD
  // rounding. Add two micro-USD before cent rounding to cover both steps.
  return (providerUsd + 0.000002) / 0.75;
}
