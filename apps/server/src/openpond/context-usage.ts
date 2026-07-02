import {
  ContextUsageSnapshotSchema,
  type ChatProvider,
  type ContextUsageSnapshot,
  type HostedContextProvider,
} from "@openpond/contracts";
import type { HostedChatMessage } from "@openpond/cloud";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const DEFAULT_HOSTED_CONTEXT_TOKENS = 128_000;
const MIN_CONTEXT_RESERVE_TOKENS = 8_000;

export function hostedContextProvider(provider: ChatProvider): HostedContextProvider | null {
  return provider === "openpond" ? provider : null;
}

export function hostedContextLimit(_provider: HostedContextProvider, model: string): number {
  const normalized = model.trim().toLowerCase();
  const contextMatch = normalized.match(/(?:^|[-_])(\d+)\s*k(?:[-_]|$)/);
  if (contextMatch?.[1]) return Number.parseInt(contextMatch[1], 10) * 1000;
  return DEFAULT_HOSTED_CONTEXT_TOKENS;
}

export function usableHostedContextLimit(maxContextTokens: number): number {
  const reserve = Math.max(MIN_CONTEXT_RESERVE_TOKENS, Math.ceil(maxContextTokens * 0.08));
  return Math.max(1, maxContextTokens - reserve);
}

export function estimateHostedMessageTokens(messages: HostedChatMessage[]): number {
  const characterCount = messages.reduce((total, message) => {
    return total + message.role.length + (message.name?.length ?? 0) + (message.content?.length ?? 0) + 8;
  }, 0);
  return Math.max(1, Math.ceil(characterCount / ESTIMATED_CHARS_PER_TOKEN) + messages.length * 4);
}

function numericUsageValue(usage: unknown, keys: string[]): number | null {
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  return null;
}

function tokenCountFromUsage(usage: unknown, includeCompletion: boolean): number | null {
  const promptTokens = numericUsageValue(usage, ["prompt_tokens", "promptTokens", "input_tokens", "inputTokens"]);
  const completionTokens = numericUsageValue(usage, [
    "completion_tokens",
    "completionTokens",
    "output_tokens",
    "outputTokens",
  ]);
  const totalTokens = numericUsageValue(usage, ["total_tokens", "totalTokens"]);

  if (includeCompletion) {
    if (totalTokens !== null) return totalTokens;
    if (promptTokens !== null && completionTokens !== null) return promptTokens + completionTokens;
    return null;
  }
  return promptTokens ?? totalTokens;
}

export function createContextUsageSnapshot(input: {
  provider: HostedContextProvider;
  model: string;
  messages: HostedChatMessage[];
  usage?: unknown;
  includeCompletion?: boolean;
  updatedAtEventId: string | null;
}): ContextUsageSnapshot {
  const usedTokensFromUsage =
    input.usage === undefined ? null : tokenCountFromUsage(input.usage, Boolean(input.includeCompletion));
  const usedTokens = usedTokensFromUsage ?? estimateHostedMessageTokens(input.messages);
  const maxContextTokens = hostedContextLimit(input.provider, input.model);
  const percentFull = Math.min(100, Math.round((usedTokens / maxContextTokens) * 100));

  return ContextUsageSnapshotSchema.parse({
    provider: input.provider,
    model: input.model,
    usedTokens,
    maxContextTokens,
    usableContextTokens: usableHostedContextLimit(maxContextTokens),
    percentFull,
    source: usedTokensFromUsage === null ? "heuristic" : "provider_usage",
    updatedAtEventId: input.updatedAtEventId,
  });
}
