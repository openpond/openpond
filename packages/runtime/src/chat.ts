import { randomUUID } from "node:crypto";
import type { HostedChatStreamDelta, HostedChatUsage, HostedModel, HostedProvider } from "@openpond/cloud";
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

const PROVIDER_CATALOG_FETCH_TIMEOUT_MS = 2500;

function displayNameForHostedModel(id: string): string {
  if (id === DEFAULT_OPENPOND_CHAT_MODEL) return "OpenPond Chat";
  if (id === "deepseek-v4-flash") return "DeepSeek V4 Flash";
  return id.replace(/[-_/]+/g, " ");
}

function displayNameForHostedProvider(id: string): string {
  if (id === "openpond") return "OpenPond Chat";
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
    requestId: input.requestId,
    signal: input.signal,
  });
}

export async function listOpChatModels(options: {
  apiBaseUrl: string;
  token: string;
  signal?: AbortSignal;
}): Promise<OpChatModelsResponse> {
  const response = await fetch(opChatEndpointUrl(options.apiBaseUrl, "models"), {
    method: "GET",
    headers: opChatHeaders(options.token, "application/json"),
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
  const response = await fetch(opChatEndpointUrl(options.apiBaseUrl, "providers"), {
    method: "GET",
    headers: opChatHeaders(options.token, "application/json"),
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
  const response = await fetch(opChatEndpointUrl(options.apiBaseUrl, "provider-catalog"), {
    method: "GET",
    headers: opChatHeaders(options.token, "application/json"),
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
  const response = await fetch(opChatEndpointUrl(options.apiBaseUrl, "chat/completions"), {
    method: "POST",
    headers: opChatHeaders(options.token, "text/event-stream", options.requestId),
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: true,
    }),
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`OpenPond OpChat stream failed: ${response.status} ${await readOpChatError(response)}`);
  }
  for await (const raw of parseOpChatSse(response.body, options.signal)) {
    if (raw && typeof raw === "object" && "error" in raw) {
      throw new Error(`OpenPond OpChat stream failed: ${errorMessageFromPayload(raw)}`);
    }
    const usage = parseUsage(raw);
    if (usage) yield { type: "usage", usage, raw };
    for (const delta of streamDeltasFromChunk(raw)) {
      yield delta;
    }
  }
}

function opChatEndpointUrl(
  apiBaseUrl: string,
  path: "models" | "providers" | "provider-catalog" | "chat/completions",
): string {
  const normalized = apiBaseUrl.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("OpenPond OpChat API base URL is required.");
  return `${normalized}/${path}`;
}

function opChatHeaders(token: string, accept: string, requestId?: string): Headers {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("OpenPond API key is required for OpChat.");
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${trimmed}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", accept);
  headers.set("x-openpond-client", "openpond-app");
  headers.set("x-openpond-request-id", requestId || randomUUID());
  return headers;
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

async function* parseOpChatSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<unknown, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abortError = () => (signal?.reason instanceof Error ? signal.reason : new Error("openpond_opchat_aborted"));
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const result = await reader.read();
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

function streamDeltasFromChunk(raw: unknown): HostedChatStreamDelta[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const deltas: HostedChatStreamDelta[] = [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const choiceRecord = choice as Record<string, unknown>;
    const delta = choiceRecord.delta && typeof choiceRecord.delta === "object"
      ? (choiceRecord.delta as Record<string, unknown>)
      : {};
    for (const key of ["content", "reasoning_content"] as const) {
      const value = stringValue(delta[key]);
      if (!value) continue;
      deltas.push({
        type: key === "content" ? "text_delta" : "reasoning_delta",
        text: value,
        raw,
      });
    }
    const finishReason = stringValue(choiceRecord.finish_reason);
    if (finishReason) deltas.push({ type: "finish", finishReason, raw });
  }
  return deltas;
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
