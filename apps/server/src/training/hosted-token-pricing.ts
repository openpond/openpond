import { normalizeModelUsageTokens } from "../runtime/model-usage-normalization.js";

export type HostedTokenPricing = {
  version: string;
  source: string;
  effectiveAt: string;
  inputUsdPerMillionTokens: number;
  cachedInputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

export function hostedTokenPricingFromCatalog(
  raw: Record<string, unknown>,
): HostedTokenPricing {
  const pricing = record(record(record(raw.metadata).billing).pricing);
  return {
    version: requiredString(pricing.version, "pricing version"),
    source: requiredString(pricing.source, "pricing source"),
    effectiveAt: requiredString(pricing.effectiveAt, "pricing effective date"),
    inputUsdPerMillionTokens: requiredRate(
      pricing.inputUsdPerMillionTokens,
      "input token rate",
    ),
    cachedInputUsdPerMillionTokens: requiredRate(
      pricing.cachedInputUsdPerMillionTokens,
      "cached input token rate",
    ),
    outputUsdPerMillionTokens: requiredRate(
      pricing.outputUsdPerMillionTokens,
      "output token rate",
    ),
  };
}

export function hostedTokenPricingFromValue(value: unknown): HostedTokenPricing | null {
  const pricing = record(value);
  try {
    return {
      version: requiredString(pricing.version, "pricing version"),
      source: requiredString(pricing.source, "pricing source"),
      effectiveAt: requiredString(pricing.effectiveAt, "pricing effective date"),
      inputUsdPerMillionTokens: requiredRate(
        pricing.inputUsdPerMillionTokens,
        "input token rate",
      ),
      cachedInputUsdPerMillionTokens: requiredRate(
        pricing.cachedInputUsdPerMillionTokens,
        "cached input token rate",
      ),
      outputUsdPerMillionTokens: requiredRate(
        pricing.outputUsdPerMillionTokens,
        "output token rate",
      ),
    };
  } catch {
    return null;
  }
}

export function hostedUsageCostUsd(
  usage: unknown,
  pricing: HostedTokenPricing,
): number | null {
  const normalized = normalizeModelUsageTokens(usage);
  if (
    normalized.promptTokens === null
    && normalized.completionTokens === null
  ) return null;
  const cached = normalized.cachedPromptTokens ?? 0;
  const uncached = normalized.uncachedPromptTokens ?? normalized.promptTokens ?? 0;
  return (
    uncached * pricing.inputUsdPerMillionTokens
    + cached * pricing.cachedInputUsdPerMillionTokens
    + (normalized.completionTokens ?? 0) * pricing.outputUsdPerMillionTokens
  ) / 1_000_000;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`Hosted model catalog is missing ${label}.`);
}

function requiredRate(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  throw new Error(`Hosted model catalog is missing ${label}.`);
}
