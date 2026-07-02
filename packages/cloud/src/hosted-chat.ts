import { randomUUID } from "node:crypto";
import { DEFAULT_OPENPOND_OPCHAT_API_BASE_URL } from "./urls.js";

export type HostedChatRole = "system" | "user" | "assistant" | "tool";

export type HostedChatToolCall = {
  id?: string;
  type: "function" | string;
  function?: {
    name?: string;
    arguments?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type HostedChatTool = {
  type: "function" | string;
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type HostedChatToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };

export type HostedChatMessage = {
  role: HostedChatRole;
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: HostedChatToolCall[];
};

export type HostedModel = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  [key: string]: unknown;
};

export type HostedProvider = {
  id: string;
  object?: string;
  display_name?: string;
  owned_by?: string;
  lifecycle_status?: string;
  credential_modes?: string[];
  routing?: Record<string, unknown>;
  default_model?: string | null;
  model_ids?: string[];
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

export type HostedModelsResponse = {
  object: "list" | string;
  data: HostedModel[];
};

export type HostedProvidersResponse = {
  object: "list" | string;
  data: HostedProvider[];
};

export type HostedChatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
};

export type HostedChatCompletion = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: HostedChatToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: HostedChatUsage;
  [key: string]: unknown;
};

export type HostedChatStreamDelta =
  | {
      type: "text_delta";
      text: string;
      raw: unknown;
    }
  | {
      type: "reasoning_delta";
      text: string;
      raw: unknown;
    }
  | {
      type: "tool_call_delta";
      toolCalls: HostedChatToolCall[];
      raw: unknown;
    }
  | {
      type: "usage";
      usage: HostedChatUsage;
      raw: unknown;
    }
  | {
      type: "finish";
      finishReason: string | null;
      raw: unknown;
    };

export type HostedChatRequestOptions = {
  apiBaseUrl: string;
  token: string;
  model: string;
  messages: HostedChatMessage[];
  requestId?: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  tools?: HostedChatTool[];
  toolChoice?: HostedChatToolChoice;
  tool_choice?: HostedChatToolChoice;
  metadata?: Record<string, unknown>;
};

export type HostedModelsRequestOptions = {
  apiBaseUrl: string;
  token: string;
  signal?: AbortSignal;
};

export type HostedModelRequestOptions = HostedModelsRequestOptions & {
  model: string;
};

export type HostedProvidersRequestOptions = HostedModelsRequestOptions;

export type HostedProviderRequestOptions = HostedModelsRequestOptions & {
  provider: string;
};

export type HostedChatApiBaseUrlOptions = {
  apiBaseUrl?: string | null;
  chatApiBaseUrl?: string | null;
  opChatApiBaseUrl?: string | null;
  env?: Record<string, string | undefined>;
};

function normalizeApiBaseUrl(value: string): string {
  const trimmed = normalizeOptionalOpChatApiBaseUrl(value);
  if (!trimmed) throw new Error("apiBaseUrl is required");
  return trimmed;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeOptionalOpChatApiBaseUrl(value?: string | null): string | null {
  let trimmed = trimTrailingSlashes(value?.trim() ?? "");
  if (!trimmed) return null;

  trimmed = trimmed
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/models(?:\/[^/]+)?$/i, "");

  if (trimmed.endsWith("/opchat/v1")) return trimmed;
  if (trimmed.endsWith("/opchat")) return `${trimmed}/v1`;
  if (trimmed.endsWith("/v1")) {
    trimmed = trimmed.slice(0, -"/v1".length);
  }
  return `${trimTrailingSlashes(trimmed)}/opchat/v1`;
}

export function resolveOpChatApiBaseUrl(
  options: HostedChatApiBaseUrlOptions = {}
): string {
  const runtimeEnv =
    options.env ??
    (typeof process !== "undefined"
      ? (process.env as Record<string, string | undefined>)
      : {});
  const explicit =
    normalizeOptionalOpChatApiBaseUrl(options.opChatApiBaseUrl) ??
    normalizeOptionalOpChatApiBaseUrl(runtimeEnv.OPENPOND_OPCHAT_API_URL);
  if (explicit) return explicit;

  const migrationInput =
    normalizeOptionalOpChatApiBaseUrl(options.chatApiBaseUrl) ??
    normalizeOptionalOpChatApiBaseUrl(runtimeEnv.OPENPOND_CHAT_API_URL) ??
    normalizeOptionalOpChatApiBaseUrl(runtimeEnv.OPENPOND_GATEWAY_URL);
  if (migrationInput) return migrationInput;

  const apiBase =
    normalizeOptionalOpChatApiBaseUrl(options.apiBaseUrl) ??
    normalizeOptionalOpChatApiBaseUrl(runtimeEnv.OPENPOND_API_URL);
  return apiBase ?? DEFAULT_OPENPOND_OPCHAT_API_BASE_URL;
}

export function resolveHostedChatApiBaseUrl(
  options: HostedChatApiBaseUrlOptions = {}
): string {
  return resolveOpChatApiBaseUrl(options);
}

function requireToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("OpenPond API key is required");
  return trimmed;
}

function hostedHeaders(
  token: string,
  accept: string,
  requestId?: string
): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${requireToken(token)}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", accept);
  headers.set("x-openpond-client", "openpond-code");
  headers.set("x-openpond-request-id", requestId || randomUUID());
  return headers;
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return response.statusText || `HTTP ${response.status}`;
  try {
    const payload = JSON.parse(text) as {
      error?: unknown;
      message?: unknown;
      code?: unknown;
    };
    const error =
      typeof payload.error === "string"
        ? payload.error
        : payload.error &&
          typeof payload.error === "object" &&
          !Array.isArray(payload.error)
        ? (payload.error as { code?: unknown; message?: unknown; type?: unknown })
        : null;
    const code =
      typeof payload.code === "string"
        ? payload.code
        : error && typeof error !== "string" && typeof error.code === "string"
        ? error.code
        : null;
    const message =
      typeof payload.message === "string"
        ? payload.message
        : error &&
          typeof error !== "string" &&
          typeof error.message === "string"
        ? error.message
        : null;
    const label =
      typeof error === "string"
        ? error
        : error && typeof error.type === "string"
        ? error.type
        : null;
    return [code, label, message].filter(Boolean).join(": ") || text;
  } catch {
    return text;
  }
}

function buildHostedChatBody(
  options: HostedChatRequestOptions,
  stream: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    stream,
  };
  if (typeof options.temperature === "number") {
    body.temperature = options.temperature;
  }
  if (typeof options.maxTokens === "number") {
    body.max_tokens = options.maxTokens;
  }
  if (options.tools) {
    body.tools = options.tools;
  }
  const toolChoice = options.toolChoice ?? options.tool_choice;
  if (toolChoice !== undefined) {
    body.tool_choice = toolChoice;
  }
  if (options.metadata) {
    body.metadata = options.metadata;
  }
  return body;
}

export async function listOpChatModels(
  options: HostedModelsRequestOptions
): Promise<HostedModelsResponse> {
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
  const response = await fetch(`${apiBaseUrl}/models`, {
    method: "GET",
    headers: hostedHeaders(options.token, "application/json"),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Hosted model list failed: ${response.status} ${await readError(
        response
      )}`
    );
  }
  return (await response.json()) as HostedModelsResponse;
}

export async function getOpChatModel(
  options: HostedModelRequestOptions
): Promise<HostedModel> {
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
  const response = await fetch(
    `${apiBaseUrl}/models/${encodeURIComponent(options.model)}`,
    {
      method: "GET",
      headers: hostedHeaders(options.token, "application/json"),
      signal: options.signal,
    }
  );
  if (!response.ok) {
    throw new Error(
      `Hosted model lookup failed: ${response.status} ${await readError(
        response
      )}`
    );
  }
  return (await response.json()) as HostedModel;
}

export const listHostedModels = listOpChatModels;

export async function listOpChatProviders(
  options: HostedProvidersRequestOptions
): Promise<HostedProvidersResponse> {
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
  const response = await fetch(`${apiBaseUrl}/providers`, {
    method: "GET",
    headers: hostedHeaders(options.token, "application/json"),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Hosted provider list failed: ${response.status} ${await readError(
        response
      )}`
    );
  }
  return (await response.json()) as HostedProvidersResponse;
}

export async function getOpChatProvider(
  options: HostedProviderRequestOptions
): Promise<HostedProvider> {
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
  const response = await fetch(
    `${apiBaseUrl}/providers/${encodeURIComponent(options.provider)}`,
    {
      method: "GET",
      headers: hostedHeaders(options.token, "application/json"),
      signal: options.signal,
    }
  );
  if (!response.ok) {
    throw new Error(
      `Hosted provider lookup failed: ${response.status} ${await readError(
        response
      )}`
    );
  }
  return (await response.json()) as HostedProvider;
}

export const listHostedProviders = listOpChatProviders;

export async function sendHostedChatTurn(
  options: HostedChatRequestOptions
): Promise<HostedChatCompletion> {
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
  const response = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: hostedHeaders(
      options.token,
      "application/json",
      options.requestId
    ),
    body: JSON.stringify(buildHostedChatBody(options, false)),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Hosted chat failed: ${response.status} ${await readError(response)}`
    );
  }
  return (await response.json()) as HostedChatCompletion;
}

type OpenAIStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: HostedChatToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: HostedChatUsage;
  error?: {
    message?: string;
    code?: string;
    type?: string;
  };
};

async function* parseOpenAISSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<unknown, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readAbortError = () =>
    signal?.reason instanceof Error
      ? signal.reason
      : new Error("hosted_chat_aborted");

  try {
    while (true) {
      if (signal?.aborted) throw readAbortError();
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") return;
        yield JSON.parse(data) as unknown;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release-lock failures when the stream is already closed.
    }
  }
}

export async function* streamHostedChatTurn(
  options: HostedChatRequestOptions
): AsyncGenerator<HostedChatStreamDelta, void, unknown> {
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
  const response = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: hostedHeaders(
      options.token,
      "text/event-stream",
      options.requestId
    ),
    body: JSON.stringify(buildHostedChatBody(options, true)),
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `Hosted chat stream failed: ${response.status} ${await readError(
        response
      )}`
    );
  }

  for await (const raw of parseOpenAISSE(response.body, options.signal)) {
    const chunk = raw as OpenAIStreamChunk;
    if (chunk.error) {
      throw new Error(chunk.error.message || "Hosted chat stream error");
    }
    if (chunk.usage) {
      yield { type: "usage", usage: chunk.usage, raw };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const content = choice.delta?.content;
    if (content) {
      yield { type: "text_delta", text: content, raw };
    }
    const reasoning = choice.delta?.reasoning_content;
    if (reasoning) {
      yield { type: "reasoning_delta", text: reasoning, raw };
    }
    const toolCalls = choice.delta?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      yield { type: "tool_call_delta", toolCalls, raw };
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      yield { type: "finish", finishReason: choice.finish_reason, raw };
    }
  }
}
