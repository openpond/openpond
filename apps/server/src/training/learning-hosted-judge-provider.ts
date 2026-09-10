import { randomUUID } from "node:crypto";
import { loadOpenPondHostedModels, streamOpenPondHostedChatTurn } from "@openpond/runtime";
import type { BoundJudgeProvider, BoundJudgeResponse } from "@openpond/evals/learning";
import { hostedTokenPricingFromCatalog, hostedUsageCostUsd } from "./hosted-token-pricing.js";
import { normalizeModelUsageTokens } from "../runtime/model-usage-normalization.js";

/** Single-dispatch transport. The fixture executor owns durable reservation and
 * settlement; this adapter must never retry an uncertain provider request. */
export function createLearningHostedJudgeProvider(deps: {
  catalog?: typeof loadOpenPondHostedModels;
  stream?: typeof streamOpenPondHostedChatTurn;
} = {}): BoundJudgeProvider {
  const catalog = deps.catalog ?? loadOpenPondHostedModels;
  const stream = deps.stream ?? streamOpenPondHostedChatTurn;
  return {
    async prepare(request) {
      if (request.providerId !== "openpond") throw new Error("The selected judge provider is not connected to the hosted judge transport.");
      // OpChat currently exposes model identities but no enforceable revision
      // selector. Never silently drop a user's immutable model revision.
      if (request.revision !== null) throw new Error("This judge transport cannot enforce a model revision; select a provider with revision support.");
      const models = await catalog();
      if (models.error) throw new Error(`Judge model catalog unavailable: ${models.error}`);
      const selected = models.models.find(model => model.id === request.modelId);
      if (!selected) throw new Error("The selected judge model is unavailable.");
      const raw = record(selected.raw);
      const pricing = hostedTokenPricingFromCatalog(raw);
      const contextWindow = positiveInteger(raw.context_window, "context window");
      const maxTokens = Math.min(4096, positiveInteger(raw.output_limit, "output limit"));
      // Reserve against the advertised maximum accepted context, not a guessed
      // characters-per-token estimate. Only complete usage releases the balance.
      const maximumChargeUsd = (contextWindow * Math.max(pricing.inputUsdPerMillionTokens, pricing.cachedInputUsdPerMillionTokens)
        + maxTokens * pricing.outputUsdPerMillionTokens) / 1_000_000;
      if (!(maximumChargeUsd > 0)) throw new Error("The judge model must have a positive known charge ceiling.");
      return {
        maximumChargeUsd,
        async dispatch(signal): Promise<BoundJudgeResponse> {
          signal?.throwIfAborted();
          let text = "";
          let modelId: string | null = null;
          let responseId: string | null = null;
          let usage: unknown = null;
          let finished = false;
          for await (const delta of stream({ model: request.modelId,
            messages: [{ role: "system", content: request.system }, { role: "user", content: request.data }],
            requestId: `learning-judge-${randomUUID()}`, maxTokens, temperature: request.temperature, signal })) {
            const payload = record(delta.raw);
            if (typeof payload.model === "string") {
              if (modelId !== null && payload.model !== modelId) throw new Error("Judge response model identity changed during streaming.");
              modelId = payload.model;
            }
            if (typeof payload.id === "string") {
              if (responseId !== null && responseId !== payload.id) throw new Error("Judge response identity changed during streaming.");
              responseId = payload.id;
            }
            if (delta.type === "text_delta") text += delta.text;
            if (text.length > 100_000) throw new Error("Judge response exceeds the retained response limit.");
            if (delta.type === "usage") usage = delta.usage;
            if (delta.type === "finish") finished = true;
          }
          if (!finished || !modelId || !responseId) throw new Error("Judge response did not include a complete model receipt.");
          const tokens = normalizeModelUsageTokens(usage);
          const costUsd = tokens.promptTokens !== null && tokens.completionTokens !== null
            ? hostedUsageCostUsd(usage, pricing) : null;
          return { text, modelId, modelRevision: null, responseId, inputTokens: tokens.promptTokens,
            outputTokens: tokens.completionTokens, costUsd };
        },
      };
    },
    // The owner calls cancellation only after its awaited dispatch has closed.
    // Unsettled reservations cannot prove that the upstream request stopped.
    async cancel({ run }) { return !run.judgeCalls?.some(call => call.status === "reserved"); },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Judge catalog is missing its ${name}.`);
  return value;
}
