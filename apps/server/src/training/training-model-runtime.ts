import type {
  ChatModelRef,
  CodexReasoningEffort,
  ProviderSettings,
} from "@openpond/contracts";
import { loadOpenPondHostedModels } from "@openpond/runtime";
import type {
  streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn,
} from "@openpond/runtime";

import {
  streamOpenAiCompatibleChatCompletion,
} from "../openpond/openai-compatible-provider.js";
import type { ProviderSecrets } from "../openpond/provider-secrets.js";
import type { createManagedAdapterChatRuntime } from "./managed-adapter-chat-runtime.js";
import type { TasksetWorkModelStream } from "./taskset-work-attempt-runner.js";
import {
  hostedTokenPricingFromCatalog,
  hostedUsageCostUsd,
  type HostedTokenPricing,
} from "./hosted-token-pricing.js";
import {
  abortableDelay,
  hostedRetryDelayForAttempt,
} from "./hosted-provider-retry.js";

export function createTrainingModelRuntime(deps: {
  loadLocalByokRuntimeState(): Promise<{
    settings: ProviderSettings;
    secrets: ProviderSecrets;
  }>;
  getManagedAdapterChatRuntime(): Pick<ReturnType<typeof createManagedAdapterChatRuntime>, "appliesTo" | "stream">;
  streamOpenPondHostedChatTurn: typeof defaultStreamOpenPondHostedChatTurn;
}) {
  const hostedPricing = new Map<string, Promise<HostedTokenPricing>>();
  const pricingFor = (modelId: string) => {
    let pending = hostedPricing.get(modelId);
    if (!pending) {
      pending = loadOpenPondHostedModels().then((catalog) => {
        if (catalog.error) throw new Error(`Hosted model pricing failed: ${catalog.error}`);
        const selected = catalog.models.find((candidate) => candidate.id === modelId);
        if (!selected) throw new Error(`Hosted model ${modelId} is unavailable.`);
        return hostedTokenPricingFromCatalog(selected.raw as Record<string, unknown>);
      });
      hostedPricing.set(modelId, pending);
      void pending.catch(() => {
        if (hostedPricing.get(modelId) === pending) hostedPricing.delete(modelId);
      });
    }
    return pending;
  };

  async function trainingModelText(input: {
    model: ChatModelRef;
    reasoningEffort?: CodexReasoningEffort | "none" | null;
    messages: Array<{ role: "system" | "user"; content: string }>;
    signal: AbortSignal;
    requestId: string;
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    responseFormat?: Record<string, unknown>;
    seed?: number;
    onUsage?: (usage: unknown, costUsd?: number) => void;
    hostedTokenPricing?: HostedTokenPricing;
  }): Promise<string> {
    let text = "";
    if (input.model.providerId === "openpond" && await deps.getManagedAdapterChatRuntime().appliesTo(input.model.modelId)) {
      for await (const delta of deps.getManagedAdapterChatRuntime().stream({
        modelId: input.model.modelId,
        messages: input.messages,
        requestId: input.requestId,
        maxNewTokens: input.maxOutputTokens,
        temperature: input.temperature,
        signal: input.signal,
      })) {
        if (delta.text) text += delta.text;
        if (delta.usage !== undefined) input.onUsage?.(delta.usage);
      }
      return text;
    }
    if (input.model.providerId === "openpond") {
      const pricing = input.hostedTokenPricing
        ?? await pricingFor(input.model.modelId);
      const retryStartedAt = Date.now();
      for (let retry = 0; ; retry += 1) {
        let emitted = false;
        try {
          for await (const delta of deps.streamOpenPondHostedChatTurn({
            model: input.model.modelId,
            messages: input.messages,
            requestId: `${input.requestId}:retry-${retry}`,
            reasoningEffort:
              input.reasoningEffort === "none"
                ? undefined
                : input.reasoningEffort ?? undefined,
            maxTokens: input.maxOutputTokens,
            temperature: input.temperature,
            topP: input.topP,
            responseFormat: input.responseFormat,
            signal: input.signal,
          })) {
            emitted = true;
            if (delta.type === "text_delta" && delta.text) text += delta.text;
            if (delta.type === "usage") {
              const cost = costFromUsage(delta.usage, pricing);
              input.onUsage?.(
                delta.usage,
                "costUsd" in cost ? cost.costUsd : undefined,
              );
            }
          }
          return text;
        } catch (error) {
          const delayMs = emitted
            ? null
            : hostedRetryDelayForAttempt(
                error,
                retry,
                Date.now() - retryStartedAt,
              );
          if (delayMs === null) throw error;
          await abortableDelay(delayMs, input.signal);
        }
      }
    }
    const state = await deps.loadLocalByokRuntimeState();
    for await (const delta of streamOpenAiCompatibleChatCompletion({
      providerId: input.model.providerId,
      settings: state.settings,
      secrets: state.secrets,
      modelId: input.model.modelId,
      messages: input.messages,
      requestId: input.requestId,
      signal: input.signal,
      reasoningEffort: input.reasoningEffort,
      maxOutputTokens: input.maxOutputTokens,
      temperature: input.temperature,
      topP: input.topP,
      seed: input.seed,
    })) {
      if (delta.type === "text_delta" && delta.text) text += delta.text;
      if (delta.type === "usage") {
        const cost = costFromUsage(delta.usage);
        input.onUsage?.(
          delta.usage,
          "costUsd" in cost ? cost.costUsd : undefined,
        );
      }
    }
    return text;
  }

  const trainingModelStream: TasksetWorkModelStream =
    async function* (input) {
      if (input.model.providerId === "openpond" && await deps.getManagedAdapterChatRuntime().appliesTo(input.model.modelId)) {
        for await (const delta of deps.getManagedAdapterChatRuntime().stream({
          modelId: input.model.modelId,
          messages: input.messages,
          requestId: input.requestId,
          signal: input.signal,
          maxNewTokens: input.maxOutputTokens,
          temperature: input.temperature,
          tools: input.tools,
          toolChoice: input.toolChoice,
        })) {
          yield {
            text: delta.text,
            toolCalls: delta.toolCalls,
            usage: delta.usage,
          };
        }
        return;
      }
      if (input.model.providerId === "openpond") {
        const pricing = input.hostedTokenPricing
          ?? await pricingFor(input.model.modelId);
        const retryStartedAt = Date.now();
        for (let retry = 0; ; retry += 1) {
          let emitted = false;
          try {
            for await (const delta of deps.streamOpenPondHostedChatTurn({
              model: input.model.modelId,
              messages: input.messages,
              tools: input.tools,
              toolChoice: input.toolChoice,
              requestId: `${input.requestId}:retry-${retry}`,
              reasoningEffort:
                input.reasoningEffort === "none"
                  ? undefined
                  : input.reasoningEffort ?? undefined,
              maxTokens: input.maxOutputTokens,
              temperature: input.temperature,
              topP: input.topP,
              signal: input.signal,
            })) {
              emitted = true;
              if (delta.type === "text_delta" && delta.text) {
                yield { text: delta.text };
              }
              if (delta.type === "tool_call_delta") {
                yield { toolCalls: delta.toolCalls };
              }
              if (delta.type === "usage") {
                yield {
                  usage: delta.usage,
                  ...costFromUsage(delta.usage, pricing),
                };
              }
              if (delta.type === "continuation") {
                yield { continuation: delta.continuation };
              }
            }
            return;
          } catch (error) {
            const delayMs = emitted
              ? null
              : hostedRetryDelayForAttempt(
                  error,
                  retry,
                  Date.now() - retryStartedAt,
                );
            if (delayMs === null) throw error;
            await abortableDelay(delayMs, input.signal);
          }
        }
      }
      const state = await deps.loadLocalByokRuntimeState();
      for await (const delta of streamOpenAiCompatibleChatCompletion({
        providerId: input.model.providerId,
        settings: state.settings,
        secrets: state.secrets,
        modelId: input.model.modelId,
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.toolChoice,
        requestId: input.requestId,
        signal: input.signal,
        reasoningEffort: input.reasoningEffort,
        maxOutputTokens: input.maxOutputTokens,
        temperature: input.temperature,
        topP: input.topP,
        seed: input.seed,
      })) {
        if (delta.type === "text_delta" && delta.text) {
          yield { text: delta.text };
        }
        if (delta.type === "tool_call_delta") {
          yield { toolCalls: delta.toolCalls };
        }
        if (delta.type === "usage") {
          yield {
            usage: delta.usage,
            ...costFromUsage(delta.usage),
          };
        }
        if (delta.type === "continuation") {
          yield { continuation: delta.continuation };
        }
      }
    };

  return {
    trainingModelText,
    trainingModelStream,
  };
}


export async function resolveBenchmarkUpstreamModel(model: ChatModelRef): Promise<{
  providerId: string;
  modelId: string;
  revision: string;
  pricing: HostedTokenPricing;
}> {
  if (model.providerId !== "openpond") {
    throw new Error(
      `Benchmark model ${model.providerId}/${model.modelId} does not expose a provider-authoritative revision.`,
    );
  }
  const hosted = await loadOpenPondHostedModels();
  if (hosted.error) throw new Error(`Hosted model admission failed: ${hosted.error}`);
  const selected = hosted.models.find((candidate) => candidate.id === model.modelId);
  if (!selected) throw new Error(`Hosted model ${model.modelId} is unavailable.`);
  return benchmarkUpstreamModelFromCatalog(
    model,
    selected.raw as Record<string, unknown>,
  );
}

export function benchmarkUpstreamModelFromCatalog(
  model: ChatModelRef,
  raw: Record<string, unknown>,
): {
  providerId: string;
  modelId: string;
  revision: string;
  pricing: HostedTokenPricing;
} {
  const metadata = record(raw.metadata);
  const provider = record(metadata.provider);
  const billing = record(metadata.billing);
  const providerId = firstString(
    raw.upstream_provider,
    raw.provider_id,
    raw.owned_by,
    metadata.upstreamProvider,
    metadata.upstream_provider,
    provider.id,
    provider.name,
    billing.providerId,
    model.modelId === "openpond-chat" ? "deepseek" : null,
  );
  const modelId = firstString(
    raw.upstream_model,
    raw.model_id,
    metadata.upstreamModel,
    metadata.upstream_model,
    model.modelId === "openpond-chat" ? "deepseek-v4-pro" : model.modelId,
  );
  const revision = firstString(
    raw.revision,
    raw.revision_id,
    raw.deployment_id,
    metadata.revision,
    metadata.revisionId,
    metadata.upstreamRevision,
    metadata.upstream_revision,
    typeof raw.created === "number" ? `catalog-created:${raw.created}` : null,
  );
  if (!providerId || !modelId || !revision) {
    const missing = [
      !providerId ? "provider" : null,
      !modelId ? "model" : null,
      !revision ? "revision" : null,
    ].filter(Boolean).join(", ");
    throw new Error(
      `Hosted model ${model.modelId} did not provide concrete catalog ${missing}.`,
    );
  }
  return {
    providerId,
    modelId,
    revision,
    pricing: hostedTokenPricingFromCatalog(raw),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function costFromUsage(
  usage: unknown,
  pricing?: HostedTokenPricing,
): { costUsd: number } | Record<string, never> {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
  const record = usage as Record<string, unknown>;
  for (const key of ["costUsd", "cost_usd", "totalCostUsd", "total_cost_usd"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return { costUsd: value };
    }
  }
  const estimated = pricing ? hostedUsageCostUsd(usage, pricing) : null;
  if (estimated !== null) return { costUsd: estimated };
  return {};
}
