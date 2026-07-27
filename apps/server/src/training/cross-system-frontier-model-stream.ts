import type { ProviderSettings } from "@openpond/contracts";
import type {
  ProviderChatGptSubscriptionCredential,
  ProviderSecrets,
} from "../openpond/provider-secrets.js";
import {
  streamOpenAiCompatibleChatCompletion,
} from "../openpond/openai-compatible-provider.js";
import type { createTrainedAdapterChatRuntime } from "./trained-adapter-chat-runtime.js";
import type { createPrimeEvaluationSessionService } from "./prime-evaluation-session.js";
import {
  LOCAL_ADAPTER_PROVIDER_ID,
  type CrossSystemFrontierModelStream,
} from "./cross-system-operations/index.js";
import type {
  streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn,
} from "@openpond/runtime";
import type { OpenAiCompatibleProviderId } from "@openpond/contracts";

export function createCrossSystemFrontierModelStream(deps: {
  primeEvaluationSessions: Pick<
    ReturnType<typeof createPrimeEvaluationSessionService>,
    "applies" | "stream"
  >;
  trainedAdapterChatRuntime: Pick<
    ReturnType<typeof createTrainedAdapterChatRuntime>,
    "stream"
  >;
  streamOpenPondHostedChatTurn: typeof defaultStreamOpenPondHostedChatTurn;
  localByokRuntimeState(): Promise<{
    settings: ProviderSettings;
    secrets: ProviderSecrets;
  }>;
  saveChatGptSubscriptionCredential(
    providerId: OpenAiCompatibleProviderId,
    credential: ProviderChatGptSubscriptionCredential,
  ): Promise<void>;
}): CrossSystemFrontierModelStream {
  return async function* (input) {
  if (deps.primeEvaluationSessions.applies(input.model)) {
    yield* deps.primeEvaluationSessions.stream(input);
    return;
  }
  if (input.model.providerId === LOCAL_ADAPTER_PROVIDER_ID) {
    for await (const delta of deps.trainedAdapterChatRuntime.stream({
      modelId: input.model.modelId,
      messages: input.messages,
      tools: input.tools,
      toolChoice: input.toolChoice,
      requestId: input.requestId,
      signal: input.signal,
    })) {
      yield { text: delta.text, toolCalls: delta.toolCalls };
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
      signal: input.signal,
    })) {
      if (delta.type === "text_delta") yield { text: delta.text };
      if (delta.type === "continuation")
        yield { continuation: delta.continuation };
      if (delta.type === "tool_call_delta")
        yield { toolCalls: delta.toolCalls };
    }
    return;
  }
  const state = await deps.localByokRuntimeState();
  const chatGptSubscription =
    input.model.providerId === "openai"
    && state.secrets.providers.openai?.source === "chatgpt_subscription";
  let providerResponseId: string | null = null;
  let providerResponseModel: string | null = null;
  let providerPromptTokens: number | null = null;
  let providerGeneratedTokens: number | null = null;
  for await (const delta of streamOpenAiCompatibleChatCompletion({
    providerId: input.model.providerId,
    settings: state.settings,
    secrets: state.secrets,
    modelId: input.model.modelId,
    messages: input.messages,
    tools: input.tools,
    toolChoice: input.toolChoice,
    requestId: input.requestId,
    reasoningEffort: input.reasoningEffort,
    signal: input.signal,
    maxOutputTokens: input.maxOutputTokens,
    temperature: input.temperature,
    topP: input.topP,
    seed: input.seed,
    saveChatGptSubscriptionCredential: deps.saveChatGptSubscriptionCredential,
  })) {
    const facts = providerResponseFactsFromRaw(delta.raw);
    providerResponseId =
      facts.responseId ?? providerResponseId;
    providerResponseModel =
      facts.responseModel ?? providerResponseModel;
    providerPromptTokens =
      facts.promptTokens ?? providerPromptTokens;
    providerGeneratedTokens =
      facts.generatedTokens ?? providerGeneratedTokens;
    if (delta.type === "text_delta") yield { text: delta.text };
    if (delta.type === "continuation")
      yield { continuation: delta.continuation };
    if (delta.type === "tool_call_delta")
      yield { toolCalls: delta.toolCalls };
  }
  if (providerResponseModel) {
    yield {
      responseFacts: {
        providerResponseIdentity: JSON.stringify({
          providerId: input.model.providerId,
          responseId: providerResponseId,
          responseModel: providerResponseModel,
        }),
        promptTokens: providerPromptTokens,
        generatedTokens: providerGeneratedTokens,
        samplingSupport: {
          seed: false,
          temperature: !chatGptSubscription,
          topP: !chatGptSubscription,
        },
      },
    };
  }
};
}

function providerResponseFactsFromRaw(value: unknown): {
  responseId: string | null;
  responseModel: string | null;
  promptTokens: number | null;
  generatedTokens: number | null;
} {
  const root =
    value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  const nested =
    root.response
    && typeof root.response === "object"
    && !Array.isArray(root.response)
      ? root.response as Record<string, unknown>
      : {};
  const usageValue =
    nested.usage
    && typeof nested.usage === "object"
    && !Array.isArray(nested.usage)
      ? nested.usage
      : root.usage;
  const usage =
    usageValue
    && typeof usageValue === "object"
    && !Array.isArray(usageValue)
      ? usageValue as Record<string, unknown>
      : {};
  return {
    responseId:
      stringFact(nested.id) ?? stringFact(root.id),
    responseModel:
      stringFact(nested.model) ?? stringFact(root.model),
    promptTokens:
      tokenFact(usage.prompt_tokens)
      ?? tokenFact(usage.input_tokens),
    generatedTokens:
      tokenFact(usage.completion_tokens)
      ?? tokenFact(usage.output_tokens),
  };
}

function stringFact(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function tokenFact(value: unknown): number | null {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    ? value
    : null;
}


