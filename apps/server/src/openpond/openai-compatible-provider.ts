import {
  ProviderModelSchema,
  type ProviderId,
  type CodexReasoningEffort,
  type ProviderModel,
  type ProviderModelCapabilities,
  type ProviderSettings,
} from "@openpond/contracts";
import type {
  HostedChatMessage,
  HostedChatContinuation,
  HostedChatTool,
  HostedChatToolCall,
  HostedChatToolChoice,
} from "@openpond/cloud";
import {
  credentialFromRefreshResponse,
  refreshOpenAiSubscriptionToken,
} from "./openai-subscription-auth.js";
import type {
  ProviderChatGptSubscriptionCredential,
  ProviderSecrets,
} from "./provider-secrets.js";
import {
  chatCompletionsContinuation,
  chatCompletionsReasoningPolicy,
  hasChatCompletionsReasoningContinuation,
} from "./reasoning-continuation.js";

export const OPENAI_COMPATIBLE_PROVIDER_IDS = [
  "local-adapter",
  "openai",
  "xai",
  "openrouter",
  "deepseek",
  "zai",
  "moonshot",
  "together",
  "groq",
  "fireworks",
  "custom-openai-compatible",
] as const satisfies readonly ProviderId[];

export type OpenAiCompatibleProviderId = (typeof OPENAI_COMPATIBLE_PROVIDER_IDS)[number];

export type OpenAiCompatibleStreamDelta =
  | { type: "text_delta"; text: string; raw: unknown }
  | { type: "reasoning_delta"; text: string; raw: unknown }
  | { type: "continuation"; continuation: HostedChatContinuation; raw: unknown }
  | { type: "tool_call_delta"; toolCalls: HostedChatToolCall[]; raw: unknown }
  | { type: "usage"; usage: unknown; raw: unknown }
  | { type: "finish"; finishReason: string; raw: unknown };

export type OpenAiCompatibleResolvedProvider = {
  providerId: OpenAiCompatibleProviderId;
  baseUrl: string;
  model: string;
  auth:
    | { type: "api_key"; apiKey: string }
    | { type: "chatgpt_subscription"; credential: ProviderChatGptSubscriptionCredential };
};

const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_PROVIDER_REQUEST_HARD_TIMEOUT_MS = 5 * 60_000;
const PROVIDER_RESPONSE_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const PROVIDER_ERROR_BODY_LIMIT_BYTES = 64 * 1024;
const OPENAI_CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_SUBSCRIPTION_TOKEN_REFRESH_MARGIN_MS = 60_000;

export function isOpenAiCompatibleProviderId(
  providerId: ProviderId,
): providerId is OpenAiCompatibleProviderId {
  return (OPENAI_COMPATIBLE_PROVIDER_IDS as readonly ProviderId[]).includes(providerId);
}

export function resolveOpenAiCompatibleProvider(input: {
  providerId: ProviderId;
  settings: ProviderSettings;
  secrets: ProviderSecrets;
  modelId?: string | null;
  baseUrl?: string | null;
  requireModel?: boolean;
}): OpenAiCompatibleResolvedProvider {
  if (!isOpenAiCompatibleProviderId(input.providerId)) {
    throw new Error(`Provider ${input.providerId} is not OpenAI-compatible.`);
  }
  const config = input.settings.providers[input.providerId];
  const cache = input.settings.modelCaches[input.providerId];
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl ?? config?.baseUrl ?? "");
  if (!baseUrl) throw new Error(`Provider ${input.providerId} requires a base URL.`);

  const secret = input.secrets.providers[input.providerId];
  const auth = resolveProviderAuth(input.providerId, secret);
  if (!auth) {
    throw new Error(missingApiKeyMessage(input.providerId, input.settings));
  }

  const model =
    input.modelId?.trim() ||
    config?.defaultModel?.trim() ||
    cache?.models.find((candidate) => candidate.id.trim())?.id.trim() ||
    "";
  if (!model && input.requireModel !== false) {
    throw new Error(`Provider ${input.providerId} requires a model.`);
  }
  return {
    providerId: input.providerId,
    baseUrl,
    auth,
    model,
  };
}

function resolveProviderAuth(
  providerId: OpenAiCompatibleProviderId,
  secret: ProviderSecrets["providers"][string] | undefined,
): OpenAiCompatibleResolvedProvider["auth"] | null {
  if (providerId === "openai" && secret?.source === "chatgpt_subscription" && secret.oauth?.refreshToken) {
    return { type: "chatgpt_subscription", credential: secret.oauth };
  }
  const apiKey =
    secret?.source === "local_secret"
      ? secret.value?.trim() ?? ""
      : secret?.source === "env" && secret.envVar
        ? process.env[secret.envVar]?.trim() ?? ""
        : "";
  if (!apiKey) return null;
  return { type: "api_key", apiKey };
}

function missingApiKeyMessage(providerId: OpenAiCompatibleProviderId, settings: ProviderSettings): string {
  const providerName = settings.statuses[providerId]?.displayName?.trim() || providerId;
  const setupHint = `Add an API key in Settings > Providers.`;
  if (providerId === "openai") {
    return `${providerName} has no connected API key. The raw OpenAI provider uses Platform API credentials. ${setupHint}`;
  }
  return `${providerName} has no connected API key. ${setupHint}`;
}

export async function listOpenAiCompatibleProviderModels(input: {
  providerId: ProviderId;
  settings: ProviderSettings;
  secrets: ProviderSecrets;
  baseUrl?: string | null;
  modelId?: string | null;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  responseBodyLimitBytes?: number;
  errorBodyLimitBytes?: number;
}): Promise<ProviderModel[]> {
  const provider = resolveOpenAiCompatibleProvider({
    ...input,
    requireModel: false,
  });
  if (provider.auth.type === "chatgpt_subscription") {
    return subscriptionModelsFromSettings(input.settings, provider.providerId);
  }
  const requestSignal = createProviderRequestSignal(input.signal, input.requestTimeoutMs);
  try {
    const response = await fetch(providerEndpointUrl(provider.baseUrl, "models"), {
      method: "GET",
      headers: providerHeaders(provider.auth.apiKey, "application/json"),
      signal: requestSignal.signal,
    });
    if (!response.ok) {
      requestSignal.touch();
      const errorDetail = await readProviderError(
        response,
        input.errorBodyLimitBytes,
        requestSignal.signal,
        requestSignal.touch,
      );
      throw new Error(
        `Provider ${provider.providerId} model list failed: ${response.status} ${providerErrorDetail(provider, errorDetail)}`,
      );
    }
    const payload = await readProviderJson(
      response,
      `Provider ${provider.providerId} model list`,
      input.responseBodyLimitBytes,
      requestSignal.signal,
      requestSignal.touch,
    );
    const models = modelsFromPayload(provider.providerId, payload);
    if (models.length === 0) {
      throw new Error(`Provider ${provider.providerId} returned no models.`);
    }
    return models;
  } finally {
    requestSignal.cleanup();
  }
}

export async function validateOpenAiCompatibleProvider(input: {
  providerId: ProviderId;
  settings: ProviderSettings;
  secrets: ProviderSecrets;
  baseUrl?: string | null;
  modelId?: string | null;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  responseBodyLimitBytes?: number;
  errorBodyLimitBytes?: number;
}): Promise<{
  providerId: OpenAiCompatibleProviderId;
  ok: boolean;
  live: true;
  baseUrl: string;
  modelId: string;
  modelFound: boolean | null;
  modelCount: number;
  errors: string[];
}> {
  const provider = resolveOpenAiCompatibleProvider(input);
  const models = await listOpenAiCompatibleProviderModels({
    ...input,
    providerId: provider.providerId,
    baseUrl: provider.baseUrl,
    modelId: provider.model,
  });
  const modelFound = models.some((model) => model.id === provider.model);
  const errors = modelFound ? [] : [`Model ${provider.model} was not returned by provider model discovery.`];
  return {
    providerId: provider.providerId,
    ok: errors.length === 0,
    live: true,
    baseUrl: provider.baseUrl,
    modelId: provider.model,
    modelFound,
    modelCount: models.length,
    errors,
  };
}

export async function* streamOpenAiCompatibleChatCompletion(input: {
  providerId: ProviderId;
  settings: ProviderSettings;
  secrets: ProviderSecrets;
  modelId?: string | null;
  messages: HostedChatMessage[];
  tools?: HostedChatTool[];
  toolChoice?: HostedChatToolChoice;
  requestId?: string;
  reasoningEffort?: CodexReasoningEffort | null;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  errorBodyLimitBytes?: number;
  saveChatGptSubscriptionCredential?: (
    providerId: OpenAiCompatibleProviderId,
    credential: ProviderChatGptSubscriptionCredential,
  ) => Promise<void>;
}): AsyncGenerator<OpenAiCompatibleStreamDelta, void, unknown> {
  const provider = resolveOpenAiCompatibleProvider(input);
  if (provider.auth.type === "chatgpt_subscription") {
    const subscriptionProvider = {
      ...provider,
      auth: provider.auth,
    };
    yield* streamOpenAiSubscriptionResponses({
      ...input,
      provider: subscriptionProvider,
    });
    return;
  }
  const requestSignal = createProviderRequestSignal(input.signal, input.requestTimeoutMs);
  try {
    const response = await fetch(providerEndpointUrl(provider.baseUrl, "chat/completions"), {
      method: "POST",
      headers: providerHeaders(provider.auth.apiKey, "text/event-stream"),
      body: JSON.stringify(buildChatCompletionBody({
        providerId: provider.providerId,
        model: provider.model,
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.toolChoice,
        reasoningEffort: input.reasoningEffort,
      })),
      signal: requestSignal.signal,
    });
    if (!response.ok || !response.body) {
      requestSignal.touch();
      const errorDetail = await readProviderError(
        response,
        input.errorBodyLimitBytes,
        requestSignal.signal,
        requestSignal.touch,
      );
      throw new Error(
        `Provider ${provider.providerId} stream failed: ${response.status} ${providerErrorDetail(provider, errorDetail)}`,
      );
    }
    let reasoningText = "";
    let hasToolCalls = false;
    let pendingFinish: OpenAiCompatibleStreamDelta | null = null;
    let latestRaw: unknown = null;
    requestSignal.touch();
    for await (const raw of parseSse(response.body, requestSignal.signal, requestSignal.touch)) {
      latestRaw = raw;
      if (raw && typeof raw === "object" && "error" in raw) {
        throw new Error(`Provider ${provider.providerId} stream failed: ${errorMessageFromPayload(raw)}`);
      }
      const usage = parseUsage(raw);
      if (usage) yield { type: "usage", usage, raw };
      for (const delta of streamDeltasFromChunk(raw)) {
        if (delta.type === "reasoning_delta") reasoningText += delta.text;
        if (delta.type === "tool_call_delta") hasToolCalls = true;
        if (delta.type === "finish") pendingFinish = delta;
        else yield delta;
      }
    }
    const continuation = chatCompletionsContinuation({
      provider: provider.providerId,
      model: provider.model,
      reasoningText,
      hasToolCalls,
    });
    if (continuation) yield { type: "continuation", continuation, raw: latestRaw };
    if (pendingFinish) yield pendingFinish;
  } finally {
    requestSignal.cleanup();
  }
}

async function* streamOpenAiSubscriptionResponses(input: {
  provider: OpenAiCompatibleResolvedProvider & {
    auth: { type: "chatgpt_subscription"; credential: ProviderChatGptSubscriptionCredential };
  };
  modelId?: string | null;
  messages: HostedChatMessage[];
  tools?: HostedChatTool[];
  toolChoice?: HostedChatToolChoice;
  requestId?: string;
  reasoningEffort?: CodexReasoningEffort | null;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  errorBodyLimitBytes?: number;
  saveChatGptSubscriptionCredential?: (
    providerId: OpenAiCompatibleProviderId,
    credential: ProviderChatGptSubscriptionCredential,
  ) => Promise<void>;
}): AsyncGenerator<OpenAiCompatibleStreamDelta, void, unknown> {
  const credential = await usableSubscriptionCredential({
    providerId: input.provider.providerId,
    credential: input.provider.auth.credential,
    saveChatGptSubscriptionCredential: input.saveChatGptSubscriptionCredential,
  });
  if (!credential.accessToken) throw new Error("OpenAI ChatGPT subscription credential has no access token.");
  const requestSignal = createProviderRequestSignal(input.signal, input.requestTimeoutMs);
  try {
    const response = await fetch(OPENAI_CODEX_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: subscriptionHeaders(credential, input.requestId),
      body: JSON.stringify(buildResponsesBody({
        model: input.provider.model,
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.toolChoice,
        reasoningEffort: input.reasoningEffort,
      })),
      signal: requestSignal.signal,
    });
    if (!response.ok || !response.body) {
      requestSignal.touch();
      const errorDetail = await readProviderError(
        response,
        input.errorBodyLimitBytes,
        requestSignal.signal,
        requestSignal.touch,
      );
      throw new Error(`Provider ${input.provider.providerId} subscription stream failed: ${response.status} ${errorDetail}`);
    }
    const seenToolArgumentDeltas = new Set<string>();
    const reasoningItems = new Map<string, Record<string, unknown>>();
    let hasToolCalls = false;
    let pendingFinish: OpenAiCompatibleStreamDelta | null = null;
    let latestRaw: unknown = null;
    requestSignal.touch();
    for await (const raw of parseSse(response.body, requestSignal.signal, requestSignal.touch)) {
      latestRaw = raw;
      if (raw && typeof raw === "object" && "error" in raw) {
        throw new Error(`Provider ${input.provider.providerId} subscription stream failed: ${errorMessageFromPayload(raw)}`);
      }
      for (const item of responsesReasoningItemsFromEvent(raw)) {
        const key = stringValue(item.id) ?? JSON.stringify(item);
        reasoningItems.set(key, item);
      }
      for (const delta of responseDeltasFromChunk(raw, seenToolArgumentDeltas)) {
        if (delta.type === "tool_call_delta") hasToolCalls = true;
        if (delta.type === "finish") pendingFinish = delta;
        else yield delta;
      }
    }
    if (hasToolCalls && reasoningItems.size > 0) {
      yield {
        type: "continuation",
        continuation: { kind: "responses_reasoning_items", items: [...reasoningItems.values()] },
        raw: latestRaw,
      };
    }
    if (pendingFinish) yield pendingFinish;
  } finally {
    requestSignal.cleanup();
  }
}

async function usableSubscriptionCredential(input: {
  providerId: OpenAiCompatibleProviderId;
  credential: ProviderChatGptSubscriptionCredential;
  saveChatGptSubscriptionCredential?: (
    providerId: OpenAiCompatibleProviderId,
    credential: ProviderChatGptSubscriptionCredential,
  ) => Promise<void>;
}): Promise<ProviderChatGptSubscriptionCredential> {
  if (
    input.credential.accessToken &&
    input.credential.expiresAt > Date.now() + OPENAI_SUBSCRIPTION_TOKEN_REFRESH_MARGIN_MS
  ) {
    return input.credential;
  }
  const refreshed = credentialFromRefreshResponse(
    await refreshOpenAiSubscriptionToken(input.credential.refreshToken),
    input.credential,
  );
  await input.saveChatGptSubscriptionCredential?.(input.providerId, refreshed);
  return refreshed;
}

function buildChatCompletionBody(input: {
  providerId: OpenAiCompatibleProviderId;
  model: string;
  messages: HostedChatMessage[];
  tools?: HostedChatTool[];
  toolChoice?: HostedChatToolChoice;
  reasoningEffort?: CodexReasoningEffort | null;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: chatCompletionMessages(mergeSystemMessages(input.messages)),
    stream: true,
  };
  if (input.tools) {
    body.tools = input.tools;
  }
  if (input.providerId === "openai" && input.reasoningEffort) body.reasoning_effort = input.reasoningEffort;
  if (input.providerId === "zai" && input.tools && input.tools.length > 0) {
    body.tool_stream = true;
  }
  const reasoningPolicy = chatCompletionsReasoningPolicy({ provider: input.providerId, model: input.model });
  if (input.tools && input.tools.length > 0 && reasoningPolicy?.requestThinking === "zai_clear_thinking") {
    body.thinking = {
      type: "enabled",
      clear_thinking: !hasChatCompletionsReasoningContinuation(input.messages),
    };
  }
  if (input.tools && input.tools.length > 0 && reasoningPolicy?.requestThinking === "deepseek_enabled") {
    body.thinking = { type: "enabled" };
  }
  if (input.toolChoice !== undefined && reasoningPolicy?.supportsToolChoice !== false) {
    body.tool_choice = input.toolChoice;
  }
  return body;
}

function chatCompletionMessages(messages: HostedChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const { continuation, ...projected } = message;
    if (continuation?.kind === "chat_completions_reasoning") {
      return { ...projected, reasoning_content: continuation.reasoningContent };
    }
    return projected;
  });
}

function buildResponsesBody(input: {
  model: string;
  messages: HostedChatMessage[];
  tools?: HostedChatTool[];
  toolChoice?: HostedChatToolChoice;
  reasoningEffort?: CodexReasoningEffort | null;
}): Record<string, unknown> {
  const projected = responsesInputFromMessages(input.messages);
  const body: Record<string, unknown> = {
    model: input.model,
    input: projected.input,
    stream: true,
    store: false,
  };
  if (projected.instructions) body.instructions = projected.instructions;
  if (input.reasoningEffort) body.reasoning = { effort: input.reasoningEffort, summary: "auto" };
  const tools = responsesTools(input.tools);
  if (tools.length > 0) body.tools = tools;
  const toolChoice = responsesToolChoice(input.toolChoice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  return body;
}

function responsesInputFromMessages(messages: HostedChatMessage[]): {
  instructions: string | null;
  input: unknown[];
} {
  const instructions: string[] = [];
  const input: unknown[] = [];
  for (const message of messages) {
    const content = typeof message.content === "string" ? message.content : "";
    if (message.role === "system") {
      if (content.trim()) instructions.push(content.trim());
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: content,
      });
      continue;
    }
    if (message.continuation?.kind === "responses_reasoning_items") {
      input.push(...message.continuation.items);
    }
    if (content.trim()) {
      input.push({
        type: "message",
        role: message.role,
        content: [
          {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: content,
          },
        ],
      });
    }
    for (const toolCall of message.tool_calls ?? []) {
      const fn = toolCall.function && typeof toolCall.function === "object" ? toolCall.function : {};
      input.push({
        type: "function_call",
        call_id: toolCall.id,
        name: fn.name,
        arguments: typeof fn.arguments === "string" ? fn.arguments : "",
      });
    }
  }
  return {
    instructions: instructions.join("\n\n") || null,
    input,
  };
}

function responsesReasoningItemsFromEvent(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const eventType = stringValue(record.type);
  if (eventType === "response.output_item.done") {
    const item = record.item && typeof record.item === "object" ? record.item as Record<string, unknown> : null;
    return item?.type === "reasoning" ? [item] : [];
  }
  if (eventType !== "response.completed") return [];
  const response = record.response && typeof record.response === "object"
    ? record.response as Record<string, unknown>
    : null;
  return Array.isArray(response?.output)
    ? response.output.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && (item as Record<string, unknown>).type === "reasoning",
      )
    : [];
}

function responsesTools(tools: HostedChatTool[] | undefined): unknown[] {
  return (tools ?? [])
    .filter((tool) => tool.type === "function" && tool.function?.name)
    .map((tool) => ({
      type: "function",
      name: tool.function!.name,
      description: tool.function!.description,
      parameters: tool.function!.parameters ?? {},
    }));
}

function responsesToolChoice(toolChoice: HostedChatToolChoice | undefined): unknown {
  if (toolChoice === undefined) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  return {
    type: "function",
    name: toolChoice.function.name,
  };
}

function mergeSystemMessages(messages: HostedChatMessage[]): HostedChatMessage[] {
  const systemContents: string[] = [];
  const nonSystemMessages: HostedChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      const content = typeof message.content === "string" ? message.content.trim() : "";
      if (content) systemContents.push(content);
      continue;
    }
    nonSystemMessages.push(message);
  }
  if (systemContents.length === 0) return messages;
  return [
    {
      role: "system",
      content: systemContents.join("\n\n"),
    },
    ...nonSystemMessages,
  ];
}

function providerEndpointUrl(baseUrl: string, path: "models" | "chat/completions"): string {
  const normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl);
  if (!normalized) throw new Error("Provider base URL is required.");
  return `${normalized}/${path}`;
}

export function normalizeOpenAiCompatibleBaseUrl(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Provider base URL must be a valid http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider base URL must use http or https.");
  }
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(path)) {
    url.pathname = path.replace(/\/chat\/completions$/i, "") || "/";
  } else if (/\/models$/i.test(path)) {
    url.pathname = path.replace(/\/models$/i, "") || "/";
  } else {
    url.pathname = path || "/";
  }
  return url.toString().replace(/\/+$/, "");
}

function providerHeaders(apiKey: string, accept: string): Headers {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("Provider API key is required.");
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${trimmed}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", accept);
  return headers;
}

function subscriptionHeaders(
  credential: ProviderChatGptSubscriptionCredential,
  requestId: string | undefined,
): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${credential.accessToken}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "text/event-stream");
  headers.set("originator", "openpond");
  headers.set("User-Agent", "openpond-app");
  if (requestId) headers.set("session-id", requestId);
  if (credential.accountId) headers.set("ChatGPT-Account-Id", credential.accountId);
  return headers;
}

function subscriptionModelsFromSettings(
  settings: ProviderSettings,
  providerId: OpenAiCompatibleProviderId,
): ProviderModel[] {
  const cached = settings.modelCaches[providerId]?.models ?? [];
  return cached.length > 0
    ? cached
    : [
        ProviderModelSchema.parse({
          id: "gpt-5.6-sol",
          providerId,
          displayName: "GPT-5.6 Sol",
          contextWindow: 400000,
          outputLimit: 128000,
          source: "curated",
          capabilities: capabilitiesForModelId("gpt-5.6-sol"),
        }),
      ];
}

function modelsFromPayload(providerId: OpenAiCompatibleProviderId, payload: unknown): ProviderModel[] {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const data = Array.isArray(record.data) ? record.data : Array.isArray(payload) ? payload : [];
  const models: ProviderModel[] = [];
  for (const item of data) {
    const model = providerModelFromUnknown(providerId, item);
    if (model) models.push(model);
  }
  return uniqueProviderModels(models);
}

function providerModelFromUnknown(
  providerId: OpenAiCompatibleProviderId,
  item: unknown,
): ProviderModel | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const id = stringValue(record.id);
  if (!id) return null;
  const displayName = stringValue(record.name) ?? stringValue(record.display_name) ?? id;
  return ProviderModelSchema.parse({
    id,
    providerId,
    displayName,
    contextWindow:
      numberValue(record.context_window) ??
      numberValue(record.context_length) ??
      numberValue(record.max_context_length) ??
      nestedNumberValue(record.top_provider, "context_length") ??
      null,
    outputLimit:
      numberValue(record.max_completion_tokens) ??
      numberValue(record.max_output_tokens) ??
      nestedNumberValue(record.top_provider, "max_completion_tokens") ??
      null,
    lifecycleStatus: "active",
    source: "provider",
    capabilities: capabilitiesForModelId(id),
    raw: rawProviderModel(record),
  });
}

function uniqueProviderModels(models: ProviderModel[]): ProviderModel[] {
  const seen = new Set<string>();
  const output: ProviderModel[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    output.push(model);
  }
  return output;
}

function capabilitiesForModelId(modelId: string): ProviderModelCapabilities {
  const normalized = modelId.toLowerCase();
  return {
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    vision: /vision|gpt-4\.1|gpt-5|gemini|claude|pixtral|vl/.test(normalized),
    reasoning: /reason|r1|o1|o3|o4|gpt-5|grok|glm-(?:4\.[5-9]|5(?:\.\d+)?)|kimi-k2/.test(normalized),
  };
}

function rawProviderModel(record: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    "id",
    "object",
    "owned_by",
    "created",
    "name",
    "display_name",
    "description",
    "context_window",
    "context_length",
    "max_context_length",
    "max_completion_tokens",
    "max_output_tokens",
    "pricing",
    "architecture",
    "top_provider",
  ];
  return Object.fromEntries(allowed.map((key) => [key, record[key]]).filter(([, value]) => value !== undefined));
}

async function readProviderError(
  response: Response,
  maxBytes = PROVIDER_ERROR_BODY_LIMIT_BYTES,
  signal?: AbortSignal,
  onProgress?: () => void,
): Promise<string> {
  const result = await readLimitedResponseText(response, maxBytes, { truncate: true }, signal, onProgress).catch(() => {
    if (signal?.aborted) throw abortReason(signal);
    return {
      text: "",
      truncated: false,
    };
  });
  const text = result.text;
  if (!text) return response.statusText || `HTTP ${response.status}`;
  try {
    return `${errorMessageFromPayload(JSON.parse(text) as unknown)}${result.truncated ? " (truncated)" : ""}`;
  } catch {
    return `${text}${result.truncated ? " (truncated)" : ""}`;
  }
}

function providerErrorDetail(
  provider: OpenAiCompatibleResolvedProvider,
  detail: string,
): string {
  if (
    provider.providerId === "zai" &&
    /\b1113\b|insufficient balance|resource package/i.test(detail)
  ) {
    return [
      detail,
      "Z.ai Coding Plan subscriptions use https://api.z.ai/api/coding/paas/v4; the general API endpoint uses separate API balance/resource packages.",
      "If this base URL is already configured, check the Coding Plan quota/reset window and that the selected model is included in the plan.",
    ].join(" ");
  }
  return detail;
}

async function readProviderJson(
  response: Response,
  label: string,
  maxBytes = PROVIDER_RESPONSE_BODY_LIMIT_BYTES,
  signal?: AbortSignal,
  onProgress?: () => void,
): Promise<unknown> {
  const result = await readLimitedResponseText(response, maxBytes, { truncate: false }, signal, onProgress);
  try {
    return JSON.parse(result.text) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

async function readLimitedResponseText(
  response: Response,
  maxBytes: number,
  options: { truncate: boolean },
  signal?: AbortSignal,
  onProgress?: () => void,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await readResponseChunk(reader, signal, onProgress);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        truncated = true;
        if (!options.truncate) {
          throw new Error(`Provider response body exceeds ${maxBytes} bytes.`);
        }
        const remaining = Math.max(0, value.byteLength - (bytes - maxBytes));
        if (remaining > 0) text += decoder.decode(value.slice(0, remaining), { stream: true });
        await reader.cancel().catch(() => undefined);
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  text += decoder.decode();
  return { text, truncated };
}

function createProviderRequestSignal(
  signal: AbortSignal | undefined,
  timeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
): { signal: AbortSignal; touch: () => void; cleanup: () => void } {
  if (signal?.aborted) throw abortReason(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortReason(signal));
  signal?.addEventListener("abort", onAbort, { once: true });
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const touch = () => {
    if (controller.signal.aborted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(new Error(`Provider request timed out after ${timeoutMs}ms without progress.`)),
      timeoutMs,
    );
  };
  touch();
  const hardTimer = setTimeout(
    () => controller.abort(new Error(`Provider request exceeded ${DEFAULT_PROVIDER_REQUEST_HARD_TIMEOUT_MS}ms.`)),
    DEFAULT_PROVIDER_REQUEST_HARD_TIMEOUT_MS,
  );
  return {
    signal: controller.signal,
    touch,
    cleanup: () => {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("provider_request_aborted");
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
  onProgress?: () => void,
) {
  if (!signal) {
    const result = await reader.read();
    if (!result.done) onProgress?.();
    return result;
  }
  if (signal.aborted) throw abortReason(signal);
  const onAbort = () => {
    void reader.cancel(abortReason(signal)).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await reader.read();
    if (signal.aborted) throw abortReason(signal);
    if (!result.done) onProgress?.();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function errorMessageFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return String(payload || "unknown_error");
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const errorRecord = error as Record<string, unknown>;
    return [
      stringValue(errorRecord.code),
      stringValue(errorRecord.type),
      stringValue(errorRecord.message),
    ]
      .filter(Boolean)
      .join(": ");
  }
  return [stringValue(record.error), stringValue(record.message)].filter(Boolean).join(": ") || JSON.stringify(payload);
}

async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  onProgress?: () => void,
): AsyncGenerator<unknown, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await readResponseChunk(reader, signal, onProgress);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        for (const payload of parseSseBlock(block)) yield payload;
      }
    }
  } finally {
    reader.releaseLock();
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const payload of parseSseBlock(buffer)) yield payload;
  }
}

function parseSseBlock(block: string): unknown[] {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return [];
  return [JSON.parse(data) as unknown];
}

function streamDeltasFromChunk(raw: unknown): OpenAiCompatibleStreamDelta[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const deltas: OpenAiCompatibleStreamDelta[] = [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const choiceRecord = choice as Record<string, unknown>;
    const delta =
      choiceRecord.delta && typeof choiceRecord.delta === "object"
        ? (choiceRecord.delta as Record<string, unknown>)
        : {};
    for (const key of ["content", "reasoning_content"] as const) {
      const value = streamTextValue(delta[key]);
      if (!value) continue;
      deltas.push({
        type: key === "content" ? "text_delta" : "reasoning_delta",
        text: value,
        raw,
      });
    }
    const toolCalls = parseToolCalls(delta.tool_calls);
    if (toolCalls.length > 0) {
      deltas.push({ type: "tool_call_delta", toolCalls, raw });
    }
    const finishReason = stringValue(choiceRecord.finish_reason);
    if (finishReason) deltas.push({ type: "finish", finishReason, raw });
  }
  return deltas;
}

function responseDeltasFromChunk(
  raw: unknown,
  seenToolArgumentDeltas: Set<string>,
): OpenAiCompatibleStreamDelta[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const type = stringValue(record.type);
  if (type === "response.output_text.delta") {
    const text = streamTextValue(record.delta);
    return text ? [{ type: "text_delta", text, raw }] : [];
  }
  if (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") {
    const text = streamTextValue(record.delta);
    return text ? [{ type: "reasoning_delta", text, raw }] : [];
  }
  if (type === "response.output_item.added") {
    const item = record.item && typeof record.item === "object" ? (record.item as Record<string, unknown>) : null;
    if (item?.type !== "function_call") return [];
    return [
      {
        type: "tool_call_delta",
        toolCalls: [
          {
            id: stringValue(item.call_id) ?? stringValue(item.id) ?? undefined,
            type: "function",
            function: {
              name: stringValue(item.name) ?? undefined,
              arguments: typeof item.arguments === "string" ? item.arguments : "",
            },
            index: numberValue(record.output_index) ?? numberValue(item.output_index) ?? 0,
          },
        ],
        raw,
      },
    ];
  }
  if (type === "response.function_call_arguments.delta") {
    const key = stringValue(record.item_id) ?? String(numberValue(record.output_index) ?? 0);
    seenToolArgumentDeltas.add(key);
    return [
      {
        type: "tool_call_delta",
        toolCalls: [
          {
            id: stringValue(record.call_id) ?? stringValue(record.item_id) ?? undefined,
            type: "function",
            function: {
              arguments: streamTextValue(record.delta) ?? "",
            },
            index: numberValue(record.output_index) ?? 0,
          },
        ],
        raw,
      },
    ];
  }
  if (type === "response.function_call_arguments.done") {
    const key = stringValue(record.item_id) ?? String(numberValue(record.output_index) ?? 0);
    if (seenToolArgumentDeltas.has(key)) return [];
    return [
      {
        type: "tool_call_delta",
        toolCalls: [
          {
            id: stringValue(record.call_id) ?? stringValue(record.item_id) ?? undefined,
            type: "function",
            function: {
              arguments: typeof record.arguments === "string" ? record.arguments : "",
            },
            index: numberValue(record.output_index) ?? 0,
          },
        ],
        raw,
      },
    ];
  }
  if (type === "response.completed") {
    const response = record.response && typeof record.response === "object" ? (record.response as Record<string, unknown>) : {};
    const output: OpenAiCompatibleStreamDelta[] = [];
    const usage = response.usage && typeof response.usage === "object" ? response.usage : null;
    if (usage) output.push({ type: "usage", usage, raw });
    output.push({ type: "finish", finishReason: "stop", raw });
    return output;
  }
  return [];
}

function parseToolCalls(value: unknown): HostedChatToolCall[] {
  return Array.isArray(value)
    ? value.filter((item): item is HostedChatToolCall => Boolean(item) && typeof item === "object")
    : [];
}

function parseUsage(raw: unknown): unknown | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = (raw as Record<string, unknown>).usage;
  return usage && typeof usage === "object" ? usage : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function streamTextValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function nestedNumberValue(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  return numberValue((value as Record<string, unknown>)[key]);
}
