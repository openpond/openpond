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
import {
  readProviderSecrets,
  type ProviderSecrets,
} from "../openpond/provider-secrets.js";
import { LOCAL_ADAPTER_PROVIDER_ID } from "./local-adapter-models.js";
import type { createTrainedAdapterChatRuntime } from "./trained-adapter-chat-runtime.js";

export function createTrainingModelRuntime(deps: {
  providerSecretPaths: Parameters<typeof readProviderSecrets>[0];
  loadLocalByokRuntimeState(): Promise<{
    settings: ProviderSettings;
    secrets: ProviderSecrets;
  }>;
  getTrainedAdapterChatRuntime(): Pick<
    ReturnType<typeof createTrainedAdapterChatRuntime>,
    "stream"
  >;
  streamOpenPondHostedChatTurn: typeof defaultStreamOpenPondHostedChatTurn;
}) {
  async function resolveFireworksCredential() {
    const credential = (await readProviderSecrets(deps.providerSecretPaths))
      .providers.fireworks;
    if (!credential) return null;
    const value = credential.source === "local_secret"
      ? credential.value
      : credential.source === "env" && credential.envVar
        ? process.env[credential.envVar] ?? null
        : null;
    if (
      !value?.trim()
      || (credential.source !== "local_secret" && credential.source !== "env")
    ) {
      return null;
    }
    return {
      value,
      source: credential.source,
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
    };
  }

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
  }): Promise<string> {
    let text = "";
    if (input.model.providerId === LOCAL_ADAPTER_PROVIDER_ID) {
      for await (const delta of deps.getTrainedAdapterChatRuntime().stream({
        modelId: input.model.modelId,
        messages: input.messages,
        requestId: input.requestId,
        signal: input.signal,
      })) {
        if (delta.text) text += delta.text;
      }
      return text;
    }
    if (input.model.providerId === "openpond") {
      for await (const delta of deps.streamOpenPondHostedChatTurn({
        model: input.model.modelId,
        messages: input.messages,
        requestId: input.requestId,
        signal: input.signal,
      })) {
        if (delta.type === "text_delta" && delta.text) text += delta.text;
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
    }
    return text;
  }

  return {
    resolveFireworksCredential,
    trainingModelText,
  };
}
