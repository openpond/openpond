import { currentAdvancedRefinerBoundary } from "./advanced-refiner-paid-boundary.js";
import { randomUUID } from "node:crypto";

import type { ChatModelRef } from "@openpond/contracts";
import { DEFAULT_REFINER_MAX_OUTPUT_TOKENS } from "@openpond/harness";
import type { streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn } from "@openpond/runtime";

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
  const base = async function* ({
    model,
    messages,
    signal,
    pricing,
    requestId: admittedRequestId,
  }: {
    model: ChatModelRef;
    messages: Parameters<typeof streamOpenPondHostedChatTurn>[0]["messages"];
    signal: AbortSignal;
    pricing: HostedTokenPricing;
    requestId?: string;
  }) {
    if (model.providerId !== "openpond") {
      throw new Error(
        "Harness Refiner benchmark model must use the admitted OpenPond hosted provider.",
      );
    }
    const requestId =
      admittedRequestId ?? `harness-refiner-benchmark:${randomUUID()}`;
    for (let retry = 0; ; retry += 1) {
      let received = false;
      try {
        const text: string[] = [];
        const usage: Array<{ usage: unknown; costUsd?: number }> = [];
        for await (const delta of streamOpenPondHostedChatTurn({
          model: model.modelId,
          messages,
          requestId: `${requestId}:retry-${retry}`,
          reasoningEffort: "low",
          maxTokens: DEFAULT_REFINER_MAX_OUTPUT_TOKENS,
          signal,
        })) {
          received = true;
          if (delta.type === "text_delta" && delta.text) {
            text.push(delta.text);
          }
          if (delta.type === "usage") {
            usage.push({
              usage: delta.usage,
              ...usageCost(delta.usage, pricing),
            });
          }
        }
        if (usage.length === 0) {
          throw new Error(
            "Harness Refiner benchmark provider response is missing usage.",
          );
        }
        // The Refiner decision parser may stop consuming as soon as it has a
        // complete JSON value. Publish accounting first so early termination
        // cannot discard the provider's trailing usage event.
        for (const item of usage) yield item;
        if (text.length > 0) yield { text: text.join("") };
        return;
      } catch (error) {
        if (
          currentAdvancedRefinerBoundary() ||
          received ||
          retry >= 2 ||
          !retryableHostedError(error)
        )
          throw error;
        await abortableDelay(hostedRetryDelayMs(error, retry), signal);
      }
    }
  };
  return async function* (input: Parameters<typeof base>[0]) {
    const boundary = currentAdvancedRefinerBoundary();
    if (!boundary) {
      yield* base(input);
      return;
    }
    if (!input.requestId)
      throw new Error(
        "Advanced Refiner provider calls require their retained exact request ID.",
      );
    const { signal, ...intent } = input;
    void signal;
    const deltas = await boundary.call(
      input.requestId,
      intent,
      input.pricing,
      DEFAULT_REFINER_MAX_OUTPUT_TOKENS,
      async () => {
        const retained: Array<{
          text?: string;
          usage?: unknown;
          costUsd?: number;
        }> = [];
        let costUsd: number | null = null;
        for await (const delta of base({
          ...input,
          signal: AbortSignal.any([input.signal, boundary.signal]),
        })) {
          retained.push(delta);
          if ("costUsd" in delta && typeof delta.costUsd === "number")
            costUsd = (costUsd ?? 0) + delta.costUsd;
        }
        return { value: retained, costUsd };
      },
    );
    for (const delta of deltas) yield delta;
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
