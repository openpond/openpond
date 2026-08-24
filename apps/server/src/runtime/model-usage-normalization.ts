import type { ModelUsageCacheTelemetrySource } from "@openpond/contracts";

export type NormalizedModelUsageTokens = {
  promptTokens: number | null;
  cachedPromptTokens: number | null;
  uncachedPromptTokens: number | null;
  cacheWritePromptTokens: number | null;
  cacheTelemetrySource: ModelUsageCacheTelemetrySource | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

const PROMPT_TOKEN_KEYS = ["prompt_tokens", "promptTokens", "input_tokens", "inputTokens"] as const;
const COMPLETION_TOKEN_KEYS = [
  "completion_tokens",
  "completionTokens",
  "output_tokens",
  "outputTokens",
] as const;
const TOTAL_TOKEN_KEYS = ["total_tokens", "totalTokens"] as const;

export function normalizeModelUsageTokens(usage: unknown): NormalizedModelUsageTokens {
  const record = usage && typeof usage === "object" && !Array.isArray(usage)
    ? usage as Record<string, unknown>
    : {};
  const reportedPromptTokens = firstTokenCount(record, PROMPT_TOKEN_KEYS);
  const cache = normalizeCacheUsage(record, reportedPromptTokens);
  const promptTokens = cache.promptTokens;
  const completionTokens = firstTokenCount(record, COMPLETION_TOKEN_KEYS);
  const reportedTotalTokens = firstTokenCount(record, TOTAL_TOKEN_KEYS);
  const totalTokens = reportedTotalTokens ?? (
    promptTokens !== null && completionTokens !== null
      ? promptTokens + completionTokens
      : null
  );
  return {
    promptTokens,
    cachedPromptTokens: cache.cachedPromptTokens,
    uncachedPromptTokens: cache.uncachedPromptTokens,
    cacheWritePromptTokens: cache.cacheWritePromptTokens,
    cacheTelemetrySource: cache.cacheTelemetrySource,
    completionTokens,
    totalTokens,
  };
}

function normalizeCacheUsage(
  usage: Record<string, unknown>,
  reportedPromptTokens: number | null,
): Pick<
  NormalizedModelUsageTokens,
  | "promptTokens"
  | "cachedPromptTokens"
  | "uncachedPromptTokens"
  | "cacheWritePromptTokens"
  | "cacheTelemetrySource"
> {
  const directCached = firstPresentTokenCount(usage, [
    "cached_input_tokens",
    "cachedInputTokens",
    "cached_prompt_tokens",
    "cachedPromptTokens",
    "prompt_cache_hit_tokens",
    "promptCacheHitTokens",
  ]);
  const directUncached = firstPresentTokenCount(usage, [
    "prompt_cache_miss_tokens",
    "promptCacheMissTokens",
  ]);
  const anthropicCached = firstPresentTokenCount(usage, [
    "cache_read_input_tokens",
    "cacheReadInputTokens",
  ]);
  const nestedCached = firstPresentNestedTokenCount(usage, [
    ["prompt_tokens_details", "cached_tokens"],
    ["promptTokensDetails", "cachedTokens"],
    ["input_tokens_details", "cached_tokens"],
    ["inputTokensDetails", "cachedTokens"],
  ]);
  const cacheWrite = firstPresentTokenCount(usage, [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_write_input_tokens",
    "cacheWriteInputTokens",
  ]);
  const cached = directCached.value !== null
    ? directCached
    : anthropicCached.value !== null
      ? anthropicCached
      : nestedCached;
  const hasCacheTelemetry = (
    cached.value !== null
    || directUncached.value !== null
    || cacheWrite.value !== null
  );
  const cacheTelemetrySource = hasCacheTelemetry
    ? cacheTelemetrySourceFromUsage(usage)
    : null;
  if (!hasCacheTelemetry) {
    return {
      promptTokens: reportedPromptTokens,
      cachedPromptTokens: null,
      uncachedPromptTokens: null,
      cacheWritePromptTokens: null,
      cacheTelemetrySource: null,
    };
  }

  const cachedPromptTokens = cached.value;
  const cacheWritePromptTokens = cacheWrite.present ? cacheWrite.value : null;
  const usesSeparatedCacheAccounting = (
    cached === anthropicCached && anthropicCached.value !== null
  ) || cacheWrite.value !== null;
  const promptTokens = reportedPromptTokens ?? (
    cached.value !== null && directUncached.value !== null
      ? cached.value + directUncached.value
      : null
  );
  if (promptTokens === null) {
    return {
      promptTokens: null,
      cachedPromptTokens,
      uncachedPromptTokens: directUncached.value,
      cacheWritePromptTokens,
      cacheTelemetrySource,
    };
  }

  if (usesSeparatedCacheAccounting) {
    const cacheReadTokens = cachedPromptTokens ?? 0;
    const cacheWriteTokens = cacheWritePromptTokens ?? 0;
    const baseUncachedPromptTokens = reportedPromptTokens ?? directUncached.value ?? 0;
    return {
      promptTokens: baseUncachedPromptTokens + cacheReadTokens + cacheWriteTokens,
      cachedPromptTokens,
      uncachedPromptTokens: baseUncachedPromptTokens + cacheWriteTokens,
      cacheWritePromptTokens,
      cacheTelemetrySource,
    };
  }

  const boundedCachedTokens = cachedPromptTokens === null
    ? null
    : Math.min(promptTokens, cachedPromptTokens);
  const uncachedPromptTokens = directUncached.value === null
    ? boundedCachedTokens === null
      ? null
      : promptTokens - boundedCachedTokens
    : Math.min(
        promptTokens - (boundedCachedTokens ?? 0),
        directUncached.value,
      );
  return {
    promptTokens,
    cachedPromptTokens: boundedCachedTokens,
    uncachedPromptTokens,
    cacheWritePromptTokens,
    cacheTelemetrySource,
  };
}

function cacheTelemetrySourceFromUsage(
  usage: Record<string, unknown>,
): ModelUsageCacheTelemetrySource {
  const value = usage.cache_telemetry_source ?? usage.cacheTelemetrySource;
  return value === "provider_response_headers"
    ? "provider_response_headers"
    : "provider_usage_body";
}

type PresentTokenCount = {
  present: boolean;
  value: number | null;
};

function firstPresentTokenCount(
  record: Record<string, unknown>,
  keys: readonly string[],
): PresentTokenCount {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    return { present: true, value: tokenCount(record[key]) };
  }
  return { present: false, value: null };
}

function firstPresentNestedTokenCount(
  record: Record<string, unknown>,
  paths: ReadonlyArray<readonly [string, string]>,
): PresentTokenCount {
  for (const [parentKey, childKey] of paths) {
    const parent = record[parentKey];
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) continue;
    const nested = parent as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(nested, childKey)) continue;
    return { present: true, value: tokenCount(nested[childKey]) };
  }
  return { present: false, value: null };
}

function firstTokenCount(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const count = tokenCount(record[key]);
    if (count !== null) return count;
  }
  return null;
}

function tokenCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
