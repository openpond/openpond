import type { ProviderSettings } from "@openpond/contracts/providers";
import type { ProviderRuntime } from "../runtime/turns/ports.js";
import type { createManagedAdapterChatRuntime } from "../training/managed-adapter-chat-runtime.js";
import { resolveUrlModel } from "../enclave/connection.js";
import { streamOpenAiCompatibleChatCompletion } from "./openai-compatible-provider.js";
import { readProviderSecrets, writeProviderChatGptSubscriptionCredential } from "./provider-secrets.js";

export function createLocalByokChatStream({ home, managedAdapterChatRuntime, localByokRuntimeState, providerSecretPaths, now }: {
  home: string;
  managedAdapterChatRuntime: ReturnType<typeof createManagedAdapterChatRuntime>;
  localByokRuntimeState: () => Promise<{ settings: ProviderSettings; secrets: Awaited<ReturnType<typeof readProviderSecrets>> }>;
  providerSecretPaths: Parameters<typeof readProviderSecrets>[0];
  now: () => string;
}): NonNullable<ProviderRuntime["streamLocalByokChatTurn"]> {
  return async function* (input) {
    if (input.providerId === "openpond" && await managedAdapterChatRuntime.appliesTo(input.modelId)) {
      yield* managedAdapterChatRuntime.stream({
        modelId: input.modelId,
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.toolChoice,
        requestId: input.requestId,
        signal: input.signal,
      });
      return;
    }
    const state = await localByokRuntimeState();
    const urlModel = input.providerId === "custom-openai-compatible" && input.modelId?.startsWith("url:")
      ? await resolveUrlModel(home, input.modelId) : null;
    if (urlModel && urlModel.protocol !== "openai") throw new Error("The selected connection is not an OpenAI-compatible model.");
    for await (const delta of streamOpenAiCompatibleChatCompletion({
      ...(urlModel ? { resolvedProvider: { providerId: "custom-openai-compatible" as const, baseUrl: urlModel.endpoint, model: urlModel.model, auth: { type: "api_key" as const, apiKey: urlModel.token } }, allowAnonymous: true } : {}),
      providerId: input.providerId,
      settings: state.settings,
      secrets: state.secrets,
      modelId: input.modelId,
      messages: input.messages,
      tools: input.tools,
      toolChoice: input.toolChoice,
      maxOutputTokens: input.maxOutputTokens,
      requestId: input.requestId,
      promptCacheKey: input.promptCacheKey,
      signal: input.signal,
      saveChatGptSubscriptionCredential: async (providerId, credential) => {
        await writeProviderChatGptSubscriptionCredential({
          paths: providerSecretPaths,
          providerId,
          credential,
          expected: state.secrets.providers[providerId] ?? {},
          timestamp: now(),
        });
      },
    })) {
      if (delta.type === "text_delta") {
        yield { text: delta.text, raw: delta.raw };
      }
      if (delta.type === "reasoning_delta") {
        yield { reasoningText: delta.text, raw: delta.raw };
      }
      if (delta.type === "continuation") {
        yield { continuation: delta.continuation, raw: delta.raw };
      }
      if (delta.type === "tool_call_delta")
        yield { toolCalls: delta.toolCalls, raw: delta.raw };
      if (delta.type === "usage")
        yield { raw: delta.raw, usage: delta.usage };
      if (delta.type === "finish")
        yield { finishReason: delta.finishReason, raw: delta.raw };
    }
  };
}
