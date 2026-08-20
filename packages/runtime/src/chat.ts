import { randomUUID } from "node:crypto";
import type {
  HostedChatMessage,
  HostedChatStreamDelta,
  HostedChatTool,
  HostedChatToolCall,
  HostedChatToolChoice,
  HostedChatUsage,
  HostedModel,
  HostedProvider,
} from "@openpond/cloud";
import { withVercelProtectionBypass } from "@openpond/cloud";
import type {
  HostedChatModel,
  HostedChatModelsResult,
  HostedChatProvider,
  HostedChatProvidersResult,
  HostedProviderCatalogResult,
  HostedChatTurnDelta,
  HostedChatTurnInput,
} from "./types.js";
import {
  DEFAULT_OPENPOND_CHAT_MODEL,
  ProviderCatalogSchema,
  type ProviderCatalog,
} from "@openpond/contracts";
import { loadOpenPondAccountContext } from "./account-context.js";
import { errorMessage } from "./errors.js";

type OpChatModelsResponse = {
  object: "list" | string;
  data: HostedModel[];
};

type OpChatProvidersResponse = {
  object: "list" | string;
  data: HostedProvider[];
};

type OpChatProviderCatalogResponse = ProviderCatalog;

const PROVIDER_CATALOG_FETCH_TIMEOUT_MS = 15_000;

function displayNameForHostedModel(id: string): string {
  if (id === DEFAULT_OPENPOND_CHAT_MODEL) return "OpenPond Chat";
  if (id === "deepseek-v4-flash") return "DeepSeek V4 Flash";
  return id.replace(/[-_/]+/g, " ");
}

function displayNameForHostedProvider(id: string): string {
  if (id === "openpond") return "OpenPond Chat";
  if (id === "xai") return "xAI / Grok";
  if (id === "openrouter") return "OpenRouter";
  if (id === "custom-openai-compatible") return "Local / Custom OpenAI-compatible";
  return id.replace(/[-_/]+/g, " ");
}

function normalizeHostedModel(model: HostedModel): HostedChatModel | null {
  const id = typeof model.id === "string" ? model.id : null;
  if (!id) return null;
  return {
    id,
    displayName: displayNameForHostedModel(id),
    ownedBy: typeof model.owned_by === "string" ? model.owned_by : null,
    streaming: true,
    raw: model,
  };
}

function normalizeHostedProvider(provider: HostedProvider): HostedChatProvider | null {
  const id = typeof provider.id === "string" ? provider.id : null;
  if (!id) return null;
  return {
    id,
    displayName:
      typeof provider.display_name === "string" && provider.display_name.trim()
        ? provider.display_name
        : displayNameForHostedProvider(id),
    ownedBy: typeof provider.owned_by === "string" ? provider.owned_by : null,
    lifecycleStatus:
      typeof provider.lifecycle_status === "string" ? provider.lifecycle_status : null,
    modelIds: Array.isArray(provider.model_ids)
      ? provider.model_ids.filter((modelId): modelId is string => typeof modelId === "string")
      : [],
    raw: provider,
  };
}

export async function loadOpenPondHostedModels(): Promise<HostedChatModelsResult> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    return {
      models: [],
      error: "No OpenPond API key or session token is configured.",
    };
  }
  try {
    const result = await listOpChatModels({
      apiBaseUrl: context.chatApiBaseUrl,
      token: context.token,
    });
    const models = result.data
      .map((model: HostedModel) => normalizeHostedModel(model))
      .filter((value: HostedChatModel | null): value is HostedChatModel => Boolean(value));
    return {
      models,
      error: null,
    };
  } catch (error) {
    return {
      models: [],
      error: errorMessage(error),
    };
  }
}

export async function loadOpenPondHostedProviders(): Promise<HostedChatProvidersResult> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    return {
      providers: [],
      error: "No OpenPond API key or session token is configured.",
    };
  }
  try {
    const result = await listOpChatProviders({
      apiBaseUrl: context.chatApiBaseUrl,
      token: context.token,
    });
    const providers = result.data
      .map((provider: HostedProvider) => normalizeHostedProvider(provider))
      .filter((value: HostedChatProvider | null): value is HostedChatProvider => Boolean(value));
    return {
      providers,
      error: null,
    };
  } catch (error) {
    return {
      providers: [],
      error: errorMessage(error),
    };
  }
}

export async function loadOpenPondProviderCatalog(): Promise<HostedProviderCatalogResult> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    return {
      catalog: null,
      error: "No OpenPond API key or session token is configured.",
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error("OpenPond provider catalog request timed out."));
  }, PROVIDER_CATALOG_FETCH_TIMEOUT_MS);
  try {
    const catalog = await listOpChatProviderCatalog({
      apiBaseUrl: context.chatApiBaseUrl,
      token: context.token,
      signal: controller.signal,
    });
    return {
      catalog,
      error: null,
    };
  } catch (error) {
    return {
      catalog: null,
      error: errorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function* streamOpenPondHostedChatTurn(
  input: HostedChatTurnInput
): AsyncGenerator<HostedChatTurnDelta, void, unknown> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account in Settings before using OpenPond Chat.");
  }
  yield* streamOpChatChatCompletion({
    apiBaseUrl: context.chatApiBaseUrl,
    token: context.token,
    model: input.model || DEFAULT_OPENPOND_CHAT_MODEL,
    messages: input.messages,
    tools: input.tools,
    toolChoice: input.toolChoice,
    requestId: input.requestId,
    reasoningEffort: input.reasoningEffort,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    topP: input.topP,
    signal: input.signal,
  });
}

export async function listOpChatModels(options: {
  apiBaseUrl: string;
  token: string;
  signal?: AbortSignal;
}): Promise<OpChatModelsResponse> {
  const requestUrl = opChatEndpointUrl(options.apiBaseUrl, "models");
  const response = await fetch(requestUrl, {
    method: "GET",
    headers: opChatHeaders(requestUrl, options.token, "application/json"),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`OpenPond OpChat model list failed: ${response.status} ${await readOpChatError(response)}`);
  }
  return (await response.json()) as OpChatModelsResponse;
}

export async function listOpChatProviders(options: {
  apiBaseUrl: string;
  token: string;
  signal?: AbortSignal;
}): Promise<OpChatProvidersResponse> {
  const requestUrl = opChatEndpointUrl(options.apiBaseUrl, "providers");
  const response = await fetch(requestUrl, {
    method: "GET",
    headers: opChatHeaders(requestUrl, options.token, "application/json"),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`OpenPond OpChat provider list failed: ${response.status} ${await readOpChatError(response)}`);
  }
  return (await response.json()) as OpChatProvidersResponse;
}

export async function listOpChatProviderCatalog(options: {
  apiBaseUrl: string;
  token: string;
  signal?: AbortSignal;
}): Promise<OpChatProviderCatalogResponse> {
  const requestUrl = opChatEndpointUrl(options.apiBaseUrl, "provider-catalog");
  const response = await fetch(requestUrl, {
    method: "GET",
    headers: opChatHeaders(requestUrl, options.token, "application/json"),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `OpenPond OpChat provider catalog failed: ${response.status} ${await readOpChatError(response)}`,
    );
  }
  return ProviderCatalogSchema.parse(await response.json());
}

export async function* streamOpChatChatCompletion(
  options: HostedChatTurnInput & {
    apiBaseUrl: string;
    token: string;
    model: string;
  }
): AsyncGenerator<HostedChatStreamDelta, void, unknown> {
  const requestUrl = opChatEndpointUrl(options.apiBaseUrl, "chat/completions");
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: opChatHeaders(
      requestUrl,
      options.token,
      "text/event-stream",
      options.requestId
    ),
    body: JSON.stringify(buildOpChatBody(options, true)),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`OpenPond OpChat request failed: ${response.status} ${await readOpChatError(response)}`);
  }
  if (!response.body) {
    throw new Error("OpenPond OpChat request failed: streaming response body is missing.");
  }

  // Stream reasoning and text deltas live as they arrive from the provider.
  // Tool call argument fragments are accumulated and yielded as a single
  // complete batch after the stream finishes, since partial JSON arguments
  // are not actionable until complete.
  const toolCalls = new Map<number, PendingOpChatToolCall>();
  let sawDone = false;
  let finishReason: string | null = null;
  let lastPayload: unknown = {};
  let accumulatedReasoning = "";
  let usage: HostedChatUsage | null = null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const consumeEvent = (): HostedChatStreamDelta[] => {
    if (dataLines.length === 0) return [];
    const data = dataLines.join("\n");
    dataLines = [];
    if (data === "[DONE]") {
      sawDone = true;
      return [];
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      throw new Error("OpenPond OpChat request failed: malformed streaming event.");
    }
    if (payload && typeof payload === "object" && "error" in payload) {
      throw new Error(`OpenPond OpChat request failed: ${errorMessageFromPayload(payload)}`);
    }
    lastPayload = payload;
    const record = payload && typeof payload === "object"
      ? payload as Record<string, unknown>
      : {};
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const choice = choices[0] && typeof choices[0] === "object"
      ? choices[0] as Record<string, unknown>
      : {};
    const delta = choice.delta && typeof choice.delta === "object"
      ? choice.delta as Record<string, unknown>
      : {};
    const deltas: HostedChatStreamDelta[] = [];
    const reasoningChunk = streamTextValue(delta.reasoning_content);
    if (reasoningChunk) {
      accumulatedReasoning += reasoningChunk;
      deltas.push({ type: "reasoning_delta", text: reasoningChunk, raw: payload });
    }
    const textChunk = streamTextValue(delta.content);
    if (textChunk) {
      deltas.push({ type: "text_delta", text: textChunk, raw: payload });
    }
    mergeOpChatToolCallDeltas(toolCalls, delta.tool_calls);
    finishReason = stringValue(choice.finish_reason) ?? finishReason;
    usage = parseUsage(payload) ?? usage;
    return deltas;
  };

  const consumeLine = (line: string): HostedChatStreamDelta[] => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!normalized) {
      return consumeEvent();
    }
    if (normalized.startsWith(":")) return [];
    if (normalized.startsWith("data:")) {
      dataLines.push(normalized.slice("data:".length).trimStart());
    }
    return [];
  };

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        for (const delta of consumeLine(line)) yield delta;
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      for (const delta of consumeLine(buffer)) yield delta;
    }
    for (const delta of consumeEvent()) yield delta;
  } finally {
    reader.releaseLock();
  }

  if (!sawDone) {
    throw new Error("OpenPond OpChat request failed: stream ended before [DONE].");
  }

  const completedToolCalls = completedOpChatToolCalls(toolCalls);
  if (completedToolCalls.length > 0) {
    yield { type: "tool_call_delta", toolCalls: completedToolCalls, raw: lastPayload };
  }
  if (completedToolCalls.length > 0 && accumulatedReasoning) {
    yield {
      type: "continuation",
      continuation: {
        kind: "chat_completions_reasoning",
        reasoningContent: accumulatedReasoning,
      },
      raw: lastPayload,
    };
  }
  if (usage) yield { type: "usage", usage, raw: lastPayload };
  yield { type: "finish", finishReason, raw: lastPayload };
}

type PendingOpChatToolCall = {
  id?: string;
  name?: string;
  arguments: string;
};

function mergeOpChatToolCallDeltas(
  calls: Map<number, PendingOpChatToolCall>,
  value: unknown,
): void {
  if (!Array.isArray(value)) return;
  value.forEach((item, position) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const index = typeof record.index === "number" && Number.isInteger(record.index)
      ? record.index
      : position;
    const current = calls.get(index) ?? { arguments: "" };
    if (typeof record.id === "string") current.id = record.id;
    const fn = record.function && typeof record.function === "object"
      ? record.function as Record<string, unknown>
      : {};
    if (typeof fn.name === "string") {
      current.name = `${current.name ?? ""}${fn.name}`;
    }
    if (typeof fn.arguments === "string") {
      current.arguments += fn.arguments;
    }
    calls.set(index, current);
  });
}

function completedOpChatToolCalls(
  calls: Map<number, PendingOpChatToolCall>,
): HostedChatToolCall[] {
  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, call]) =>
      call.id && call.name
        ? [{
            id: call.id,
            type: "function" as const,
            function: {
              name: call.name,
              arguments: call.arguments,
            },
          }]
        : []
    );
}

export function buildOpChatBody(options: {
  model: string;
  messages: HostedChatTurnInput["messages"];
  tools?: HostedChatTool[];
  toolChoice?: HostedChatToolChoice;
  reasoningEffort?: HostedChatTurnInput["reasoningEffort"];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages.map(opChatMessage),
    stream,
  };
  if (options.tools) {
    body.tools = options.tools;
  }
  if (options.toolChoice !== undefined) {
    body.tool_choice = options.toolChoice;
  }
  if (typeof options.maxTokens === "number") {
    body.max_tokens = options.maxTokens;
  }
  if (typeof options.temperature === "number") {
    body.temperature = options.temperature;
  }
  if (typeof options.topP === "number") {
    body.top_p = options.topP;
  }
  Object.assign(body, opChatReasoningFields(options.reasoningEffort));
  return body;
}

export function opChatReasoningFields(
  effort: HostedChatTurnInput["reasoningEffort"]
): Record<string, unknown> {
  if (!effort) return {};
  if (effort === "low") {
    return { thinking: { type: "disabled" } };
  }
  return {
    thinking: { type: "enabled" },
    reasoning_effort: effort === "xhigh" ? "max" : "high",
  };
}

function opChatMessage(message: HostedChatMessage): Record<string, unknown> {
  const { continuation, ...projected } = message;
  if (
    message.role === "assistant" &&
    continuation?.kind === "chat_completions_reasoning"
  ) {
    return {
      ...projected,
      reasoning_content: continuation.reasoningContent,
    };
  }
  return projected;
}

function opChatEndpointUrl(
  apiBaseUrl: string,
  path: "models" | "providers" | "provider-catalog" | "chat/completions",
): string {
  const normalized = apiBaseUrl.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("OpenPond OpChat API base URL is required.");
  return `${normalized}/${path}`;
}

function opChatHeaders(
  requestUrl: string,
  token: string,
  accept: string,
  requestId?: string
): Headers {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("OpenPond API key is required for OpChat.");
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${trimmed}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", accept);
  headers.set("x-openpond-client", "openpond-app");
  headers.set("x-openpond-request-id", requestId || randomUUID());
  return withVercelProtectionBypass(requestUrl, headers);
}

async function readOpChatError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return response.statusText || `HTTP ${response.status}`;
  try {
    return errorMessageFromPayload(JSON.parse(text) as unknown);
  } catch {
    return text;
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

function parseUsage(raw: unknown): HostedChatUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = (raw as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  return usage as HostedChatUsage;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function streamTextValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
