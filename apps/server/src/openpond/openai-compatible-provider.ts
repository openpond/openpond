import { randomUUID } from "node:crypto";
import {
  ProviderModelSchema,
  type ProviderId,
  type ProviderModel,
  type ProviderModelCapabilities,
  type ProviderSettings,
} from "@openpond/contracts";
import type {
  HostedChatMessage,
  HostedChatTool,
  HostedChatToolCall,
  HostedChatToolChoice,
} from "@openpond/cloud";
import type { ProviderSecrets } from "./provider-secrets.js";

export const OPENAI_COMPATIBLE_PROVIDER_IDS = [
  "openai",
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
  | { type: "tool_call_delta"; toolCalls: HostedChatToolCall[]; raw: unknown }
  | { type: "usage"; usage: unknown; raw: unknown }
  | { type: "finish"; finishReason: string; raw: unknown };

export type OpenAiCompatibleResolvedProvider = {
  providerId: OpenAiCompatibleProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
};

const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 30_000;
const PROVIDER_RESPONSE_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const PROVIDER_ERROR_BODY_LIMIT_BYTES = 64 * 1024;

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
  const apiKey =
    secret?.source === "local_secret"
      ? secret.value?.trim() ?? ""
      : secret?.source === "env" && secret.envVar
        ? process.env[secret.envVar]?.trim() ?? ""
        : "";
  if (!apiKey) {
    throw new Error(`Provider ${input.providerId} has no connected API key.`);
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
    apiKey,
    model,
  };
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
  const requestSignal = createProviderRequestSignal(input.signal, input.requestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(providerEndpointUrl(provider.baseUrl, "models"), {
      method: "GET",
      headers: providerHeaders(provider.apiKey, "application/json"),
      signal: requestSignal.signal,
    });
  } finally {
    requestSignal.cleanup();
  }
  if (!response.ok) {
    throw new Error(
      `Provider ${provider.providerId} model list failed: ${response.status} ${await readProviderError(response, input.errorBodyLimitBytes)}`,
    );
  }
  const payload = await readProviderJson(
    response,
    `Provider ${provider.providerId} model list`,
    input.responseBodyLimitBytes,
  );
  const models = modelsFromPayload(provider.providerId, payload);
  if (models.length === 0) {
    throw new Error(`Provider ${provider.providerId} returned no models.`);
  }
  return models;
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
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  errorBodyLimitBytes?: number;
}): AsyncGenerator<OpenAiCompatibleStreamDelta, void, unknown> {
  const provider = resolveOpenAiCompatibleProvider(input);
  const requestSignal = createProviderRequestSignal(input.signal, input.requestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(providerEndpointUrl(provider.baseUrl, "chat/completions"), {
      method: "POST",
      headers: providerHeaders(provider.apiKey, "text/event-stream", input.requestId),
      body: JSON.stringify(buildChatCompletionBody({
        model: provider.model,
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.toolChoice,
      })),
      signal: requestSignal.signal,
    });
  } finally {
    requestSignal.cleanup();
  }
  if (!response.ok || !response.body) {
    throw new Error(
      `Provider ${provider.providerId} stream failed: ${response.status} ${await readProviderError(response, input.errorBodyLimitBytes)}`,
    );
  }
  for await (const raw of parseSse(response.body, input.signal)) {
    if (raw && typeof raw === "object" && "error" in raw) {
      throw new Error(`Provider ${provider.providerId} stream failed: ${errorMessageFromPayload(raw)}`);
    }
    const usage = parseUsage(raw);
    if (usage) yield { type: "usage", usage, raw };
    for (const delta of streamDeltasFromChunk(raw)) {
      yield delta;
    }
  }
}

function buildChatCompletionBody(input: {
  model: string;
  messages: HostedChatMessage[];
  tools?: HostedChatTool[];
  toolChoice?: HostedChatToolChoice;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    stream: true,
  };
  if (input.tools) {
    body.tools = input.tools;
  }
  if (input.toolChoice !== undefined) {
    body.tool_choice = input.toolChoice;
  }
  return body;
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

function providerHeaders(apiKey: string, accept: string, requestId?: string): Headers {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("Provider API key is required.");
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${trimmed}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", accept);
  headers.set("x-openpond-client", "openpond-app");
  headers.set("x-openpond-request-id", requestId || randomUUID());
  return headers;
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
    reasoning: /reason|r1|o1|o3|o4|gpt-5|glm-(?:4\.[5-9]|5(?:\.\d+)?)|kimi-k2/.test(normalized),
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

async function readProviderError(response: Response, maxBytes = PROVIDER_ERROR_BODY_LIMIT_BYTES): Promise<string> {
  const result = await readLimitedResponseText(response, maxBytes, { truncate: true }).catch(() => ({
    text: "",
    truncated: false,
  }));
  const text = result.text;
  if (!text) return response.statusText || `HTTP ${response.status}`;
  try {
    return `${errorMessageFromPayload(JSON.parse(text) as unknown)}${result.truncated ? " (truncated)" : ""}`;
  } catch {
    return `${text}${result.truncated ? " (truncated)" : ""}`;
  }
}

async function readProviderJson(response: Response, label: string, maxBytes = PROVIDER_RESPONSE_BODY_LIMIT_BYTES): Promise<unknown> {
  const result = await readLimitedResponseText(response, maxBytes, { truncate: false });
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
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
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
): { signal: AbortSignal; cleanup: () => void } {
  if (signal?.aborted) throw abortReason(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortReason(signal));
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`Provider request timed out after ${timeoutMs}ms.`)),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("provider_request_aborted");
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
): AsyncGenerator<unknown, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abortError = () => (signal?.reason instanceof Error ? signal.reason : new Error("provider_stream_aborted"));
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
      const value = stringValue(delta[key]);
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

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function nestedNumberValue(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  return numberValue((value as Record<string, unknown>)[key]);
}
