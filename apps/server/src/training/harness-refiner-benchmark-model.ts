import { randomUUID } from "node:crypto";

import type { ChatModelRef } from "@openpond/contracts";
import { DEFAULT_REFINER_MAX_OUTPUT_TOKENS } from "@openpond/harness";
import type {
  streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn,
} from "@openpond/runtime";

import {
  hostedUsageCostUsd,
  type HostedTokenPricing,
} from "./hosted-token-pricing.js";
import {
  abortableDelay,
  hostedRetryDelayMs,
  retryableHostedError,
} from "./hosted-provider-retry.js";

export function createHarnessRefinerBenchmarkModelStream(
  streamOpenPondHostedChatTurn: typeof defaultStreamOpenPondHostedChatTurn,
) {
  return async function* ({
    model,
    messages,
    signal,
    pricing,
  }: {
    model: ChatModelRef;
    messages: Parameters<typeof streamOpenPondHostedChatTurn>[0]["messages"];
    signal: AbortSignal;
    pricing: HostedTokenPricing;
  }) {
    if (model.providerId !== "openpond") {
      throw new Error("Harness Refiner benchmark model must use the admitted OpenPond hosted provider.");
    }
    const requestId = `harness-refiner-benchmark:${randomUUID()}`;
    for (let retry = 0; ; retry += 1) {
      let emitted = false;
      try {
        for await (const delta of streamOpenPondHostedChatTurn({
          model: model.modelId,
          messages,
          requestId: `${requestId}:retry-${retry}`,
          reasoningEffort: "low",
          maxTokens: DEFAULT_REFINER_MAX_OUTPUT_TOKENS,
          signal,
        })) {
          emitted = true;
          if (delta.type === "text_delta" && delta.text) {
            yield { text: delta.text };
          }
          if (delta.type === "usage") {
            yield { usage: delta.usage, ...usageCost(delta.usage, pricing) };
          }
        }
        return;
      } catch (error) {
        if (emitted || retry >= 2 || !retryableHostedError(error)) throw error;
        await abortableDelay(hostedRetryDelayMs(error, retry), signal);
      }
    }
  };
}

function usageCost(
  usage: unknown,
  pricing: Parameters<typeof hostedUsageCostUsd>[1],
): { costUsd: number } | Record<string, never> {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
  const record = usage as Record<string, unknown>;
  for (const key of ["costUsd", "cost_usd", "totalCostUsd", "total_cost_usd"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return { costUsd: value };
    }
  }
  const estimated = hostedUsageCostUsd(usage, pricing);
  if (estimated !== null) return { costUsd: estimated };
  return {};
}
