export type NormalizedModelUsageTokens = {
  promptTokens: number | null;
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
  const promptTokens = firstTokenCount(record, PROMPT_TOKEN_KEYS);
  const completionTokens = firstTokenCount(record, COMPLETION_TOKEN_KEYS);
  const reportedTotalTokens = firstTokenCount(record, TOTAL_TOKEN_KEYS);
  const totalTokens = reportedTotalTokens ?? (
    promptTokens !== null && completionTokens !== null
      ? promptTokens + completionTokens
      : null
  );
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
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
