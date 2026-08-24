import {
  ContextUsageSnapshotSchema,
  type ChatProvider,
  type ContextUsageSource,
  type ContextUsageSnapshot,
  type HostedContextProvider,
  type ProviderSettings,
} from "@openpond/contracts";
import type { HostedChatMessage, HostedChatTool } from "@openpond/cloud";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const DEFAULT_HOSTED_CONTEXT_TOKENS = 128_000;
const MIN_CONTEXT_RESERVE_TOKENS = 8_000;
const DEFAULT_REQUESTED_OUTPUT_TOKENS = 8_192;
const MIN_REQUEST_SAFETY_RESERVE_TOKENS = 1_024;

export type HostedRequestBudget = {
  messageTokens: number;
  toolDefinitionTokens: number;
  continuationTokens: number;
  outputAllowanceTokens: number;
  safetyReserveTokens: number;
  projectedTokens: number;
  maxContextTokens: number | null;
  tokenSource: ContextUsageSource;
  tokenModelFamily: string | null;
};

export type HostedMessageTokenEstimate = {
  tokens: number;
  source: Extract<ContextUsageSource, "model_family" | "heuristic">;
  modelFamily: string | null;
};

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
  const scaledMinimumReserve = Math.min(MIN_CONTEXT_RESERVE_TOKENS, Math.ceil(maxContextTokens * 0.25));
  const reserve = Math.min(maxContextTokens - 1, Math.max(scaledMinimumReserve, Math.ceil(maxContextTokens * 0.08)));
  return Math.max(1, maxContextTokens - reserve);
}

export const usableContextLimit = usableHostedContextLimit;

export function trustedProviderContextLimit(input: {
  provider: ChatProvider;
  model: string | null | undefined;
  settings?: ProviderSettings | null;
}): number | null {
  const model = input.model?.trim();
  if (!model) return null;
  const cache = input.settings?.modelCaches[input.provider];
  const cachedModel = cache?.models.find((candidate) => candidate.id === model);
  if (cachedModel?.contextWindow) return cachedModel.contextWindow;

  const hostedProvider = hostedContextProvider(input.provider);
  if (hostedProvider) return hostedContextLimit(hostedProvider, model);
  return null;
}

export function trustedProviderOutputLimit(input: {
  provider: ChatProvider;
  model: string | null | undefined;
  settings?: ProviderSettings | null;
}): number | null {
  const model = input.model?.trim();
  if (!model) return null;
  const cachedModel = input.settings?.modelCaches[input.provider]?.models.find(
    (candidate) => candidate.id === model,
  );
  return cachedModel?.outputLimit ?? null;
}

export function estimateHostedMessageTokens(messages: HostedChatMessage[]): number {
  const characterCount = messages.reduce((total, message) => {
    return total + message.role.length + (message.name?.length ?? 0) + (message.content?.length ?? 0) + 8;
  }, 0);
  return Math.max(1, Math.ceil(characterCount / ESTIMATED_CHARS_PER_TOKEN) + messages.length * 4);
}

export function estimateHostedMessageTokensForProvider(input: {
  provider: ChatProvider;
  model: string | null | undefined;
  messages: HostedChatMessage[];
}): HostedMessageTokenEstimate {
  const modelFamily = modelTokenFamily(input.provider, input.model);
  if (!modelFamily) {
    return { tokens: estimateHostedMessageTokens(input.messages), source: "heuristic", modelFamily: null };
  }
  const tokens = input.messages.reduce((total, message) => {
    return total
      + 4
      + estimateModelFamilyTextTokens(message.role, modelFamily)
      + estimateModelFamilyTextTokens(message.name ?? "", modelFamily)
      + estimateModelFamilyTextTokens(message.content ?? "", modelFamily);
  }, 1);
  return { tokens: Math.max(1, tokens), source: "model_family", modelFamily };
}

export function hostedRequestedOutputTokens(input: {
  maxContextTokens?: number | null;
  modelOutputLimit?: number | null;
}): number {
  const contextBound = input.maxContextTokens
    ? Math.max(256, Math.floor(input.maxContextTokens / 8))
    : DEFAULT_REQUESTED_OUTPUT_TOKENS;
  const modelBound = input.modelOutputLimit && input.modelOutputLimit > 0
    ? Math.floor(input.modelOutputLimit)
    : Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.min(DEFAULT_REQUESTED_OUTPUT_TOKENS, contextBound, modelBound));
}

export function estimateHostedRequestBudget(input: {
  provider: ChatProvider;
  model?: string | null;
  messages: HostedChatMessage[];
  tools?: readonly HostedChatTool[];
  maxOutputTokens: number;
  maxContextTokens?: number | null;
}): HostedRequestBudget {
  const maxContextTokens = input.maxContextTokens ?? null;
  const messageEstimate = estimateHostedMessageTokensForProvider({
    provider: input.provider,
    model: input.model,
    messages: input.messages,
  });
  const messageTokens = messageEstimate.tokens;
  const toolDefinitionTokens = estimatedSerializedTokens(input.tools ?? []);
  const continuationTokens = estimatedSerializedTokens(
    input.messages.flatMap((message) => {
      const structural: Record<string, unknown> = {};
      if (message.continuation !== undefined) structural.continuation = message.continuation;
      if (message.tool_calls !== undefined) structural.tool_calls = message.tool_calls;
      if (message.tool_call_id !== undefined) structural.tool_call_id = message.tool_call_id;
      return Object.keys(structural).length > 0 ? [structural] : [];
    }),
  );
  const outputAllowanceTokens = Math.max(1, Math.floor(input.maxOutputTokens));
  const safetyReserveTokens = requestSafetyReserveTokens(input.provider, maxContextTokens);
  return {
    messageTokens,
    toolDefinitionTokens,
    continuationTokens,
    outputAllowanceTokens,
    safetyReserveTokens,
    projectedTokens:
      messageTokens
      + toolDefinitionTokens
      + continuationTokens
      + outputAllowanceTokens
      + safetyReserveTokens,
    maxContextTokens,
    tokenSource: messageEstimate.source,
    tokenModelFamily: messageEstimate.modelFamily,
  };
}

function estimatedSerializedTokens(value: unknown): number {
  if (Array.isArray(value) && value.length === 0) return 0;
  const serialized = JSON.stringify(value);
  if (!serialized || serialized === "[]" || serialized === "{}") return 0;
  return Math.max(1, Math.ceil(serialized.length / ESTIMATED_CHARS_PER_TOKEN));
}

function requestSafetyReserveTokens(
  _provider: ChatProvider,
  maxContextTokens: number | null,
): number {
  if (!maxContextTokens) return MIN_REQUEST_SAFETY_RESERVE_TOKENS * 2;
  return Math.min(
    Math.max(1, Math.floor(maxContextTokens / 8)),
    Math.max(MIN_REQUEST_SAFETY_RESERVE_TOKENS, Math.ceil(maxContextTokens * 0.02)),
  );
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
  provider: ChatProvider;
  model: string;
  messages: HostedChatMessage[];
  maxContextTokens?: number | null;
  usage?: unknown;
  includeCompletion?: boolean;
  updatedAtEventId: string | null;
}): ContextUsageSnapshot {
  const usedTokensFromUsage =
    input.usage === undefined ? null : tokenCountFromUsage(input.usage, Boolean(input.includeCompletion));
  const estimate = estimateHostedMessageTokensForProvider({
    provider: input.provider,
    model: input.model,
    messages: input.messages,
  });
  const usedTokens = usedTokensFromUsage ?? estimate.tokens;
  const maxContextTokens = input.maxContextTokens ?? trustedProviderContextLimit({
    provider: input.provider,
    model: input.model,
  });
  if (!maxContextTokens) {
    throw new Error(`Cannot create context usage snapshot without a trusted context limit for ${input.provider}.`);
  }
  const percentFull = Math.min(100, Math.round((usedTokens / maxContextTokens) * 100));

  return ContextUsageSnapshotSchema.parse({
    provider: input.provider,
    model: input.model,
    usedTokens,
    maxContextTokens,
    usableContextTokens: usableHostedContextLimit(maxContextTokens),
    percentFull,
    source: usedTokensFromUsage === null ? estimate.source : "provider_usage",
    updatedAtEventId: input.updatedAtEventId,
  });
}

function modelTokenFamily(provider: ChatProvider, model: string | null | undefined): string | null {
  const normalized = `${provider}/${model ?? ""}`.toLowerCase();
  if (/\b(?:gpt|o[1-9]|codex)\b/.test(normalized)) return "openai_cl100k";
  if (normalized.includes("claude") || provider === "anthropic") return "anthropic_claude";
  if (normalized.includes("deepseek") || normalized.includes("kimi") || normalized.includes("glm")) {
    return "multilingual_code";
  }
  return null;
}

function estimateModelFamilyTextTokens(value: string, family: string): number {
  if (!value) return 0;
  const cjkCharacters = [...value].filter((character) => /[\u3000-\u9fff\uf900-\ufaff]/u.test(character)).length;
  const remainingCharacters = Math.max(0, value.length - cjkCharacters);
  const charsPerToken = family === "anthropic_claude" ? 3.85 : family === "multilingual_code" ? 3.65 : 3.75;
  return Math.max(1, cjkCharacters + Math.ceil(remainingCharacters / charsPerToken));
}
