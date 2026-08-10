import type {
  ChatModelRef,
  CodexReasoningEffort,
  ProviderSettings,
} from "@openpond/contracts";
import type {
  streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn,
} from "@openpond/runtime";

import {
  streamOpenAiCompatibleChatCompletion,
} from "../openpond/openai-compatible-provider.js";
import type { ProviderSecrets } from "../openpond/provider-secrets.js";
import type { createManagedAdapterChatRuntime } from "./managed-adapter-chat-runtime.js";
import type { TasksetWorkModelStream } from "./taskset-work-attempt-runner.js";

export function createTrainingModelRuntime(deps: {
  loadLocalByokRuntimeState(): Promise<{
    settings: ProviderSettings;
    secrets: ProviderSecrets;
  }>;
  getManagedAdapterChatRuntime(): Pick<ReturnType<typeof createManagedAdapterChatRuntime>, "appliesTo" | "stream">;
  streamOpenPondHostedChatTurn: typeof defaultStreamOpenPondHostedChatTurn;
}) {
  async function trainingModelText(input: {
    model: ChatModelRef;
    reasoningEffort?: CodexReasoningEffort | "none" | null;
    messages: Array<{ role: "system" | "user"; content: string }>;
    signal: AbortSignal;
    requestId: string;
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    seed?: number;
    onUsage?: (usage: unknown, costUsd?: number) => void;
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
      for await (const delta of deps.streamOpenPondHostedChatTurn({
        model: input.model.modelId,
        messages: input.messages,
        requestId: input.requestId,
        reasoningEffort:
          input.reasoningEffort === "none"
            ? undefined
            : input.reasoningEffort ?? undefined,
        maxTokens: input.maxOutputTokens,
        temperature: input.temperature,
        topP: input.topP,
        signal: input.signal,
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
        for await (const delta of deps.streamOpenPondHostedChatTurn({
          model: input.model.modelId,
          messages: input.messages,
          tools: input.tools,
          toolChoice: input.toolChoice,
          requestId: input.requestId,
          reasoningEffort:
            input.reasoningEffort === "none"
              ? undefined
              : input.reasoningEffort ?? undefined,
          maxTokens: input.maxOutputTokens,
          temperature: input.temperature,
          topP: input.topP,
          signal: input.signal,
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
        return;
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

function costFromUsage(usage: unknown): { costUsd: number } | Record<string, never> {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
  const record = usage as Record<string, unknown>;
  for (const key of ["costUsd", "cost_usd", "totalCostUsd", "total_cost_usd"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return { costUsd: value };
    }
  }
  return {};
}
