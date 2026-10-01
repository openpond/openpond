import type { ConnectedUsage } from "../contracts.js";
import { object } from "../normalize.js";
export function sourceUsage(value: unknown, invocationId: string, provenance: ConnectedUsage["provenance"] = "reported_invocation"): ConnectedUsage | null {
  const usage = object(value);
  const number = (...values: unknown[]) => {
    const value = values.find(item => typeof item === "number" && Number.isSafeInteger(item) && item >= 0);
    return typeof value === "number" ? value : null;
  };
  const inputTokens = number(usage.input_tokens, usage.prompt_tokens);
  const outputTokens = number(usage.output_tokens, usage.completion_tokens);
  const cachedInputTokens = number(usage.cache_read_input_tokens, usage.cached_input_tokens, object(usage.input_tokens_details).cached_tokens);
  const totalTokens = number(usage.total_tokens);
  if (inputTokens === null && outputTokens === null && cachedInputTokens === null && totalTokens === null) return null;
  return { invocationId, inputTokens, outputTokens, cachedInputTokens, totalTokens, provenance };
}
