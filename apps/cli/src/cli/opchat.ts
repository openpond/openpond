import { randomUUID } from "node:crypto";
import { loadConfig } from "../config";
import {
  getOpChatModel,
  listOpChatModels,
  resolveOpChatApiBaseUrl,
  sendHostedChatTurn,
  streamHostedChatTurn,
} from "../hosted-chat";
import { runOpChatSmoke } from "../opchat-smoke";
import {
  ensureApiKey,
  parseBooleanOption,
  resolveApiBaseUrlOption,
  resolveBaseUrl,
  resolveChatApiBaseUrlOption,
} from "./common";

const STAGING_OPCHAT_API_BASE_URL =
  "https://api-new.staging-api.openpond.ai/opchat/v1";

export async function runOpChatCommand(
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<void> {
  const subcommand = rest[0] || "smoke";
  const config = await loadConfig();
  const apiKey = await ensureApiKey(config, resolveBaseUrl(config));
  const apiBaseUrl = resolveOpChatCliBaseUrl(config, options);

  if (
    subcommand === "provider-catalog" ||
    subcommand === "providers-catalog" ||
    subcommand === "catalog"
  ) {
    const catalog = await getOpChatProviderCatalog({ apiBaseUrl, token: apiKey });
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }

  if (subcommand === "models" || subcommand === "model-list") {
    const models = await listOpChatModels({ apiBaseUrl, token: apiKey });
    console.log(JSON.stringify(models, null, 2));
    return;
  }

  if (subcommand === "model" || subcommand === "model-get") {
    const model = rest[1] || optionString(options, "model");
    if (!model) {
      throw new Error("usage: opchat model <model> [--env staging]");
    }
    const result = await getOpChatModel({ apiBaseUrl, token: apiKey, model });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "chat") {
    const model = optionString(options, "model") || "openpond-chat";
    const message =
      optionString(options, "message") ||
      optionString(options, "prompt") ||
      "Reply with a short confirmation from OpChat.";
    const stream = parseBooleanOption(options.stream);
    if (!stream) {
      const completion = await sendHostedChatTurn({
        apiBaseUrl,
        token: apiKey,
        model,
        messages: [{ role: "user", content: message }],
      });
      console.log(JSON.stringify(completion, null, 2));
      return;
    }

    let text = "";
    let finishReason: string | null = null;
    let usage: unknown = null;
    for await (const chunk of streamHostedChatTurn({
      apiBaseUrl,
      token: apiKey,
      model,
      messages: [{ role: "user", content: message }],
    })) {
      if (chunk.type === "text_delta") {
        text += chunk.text;
        process.stdout.write(chunk.text);
      } else if (chunk.type === "finish") {
        finishReason = chunk.finishReason;
      } else if (chunk.type === "usage") {
        usage = chunk.usage;
      }
    }
    process.stdout.write("\n");
    console.log(JSON.stringify({ finishReason, usage, text }, null, 2));
    return;
  }

  if (subcommand === "smoke") {
    const summary = await runOpChatSmoke({
      apiBaseUrl,
      token: apiKey,
      defaultModel: optionString(options, "model") || undefined,
      compatibilityModel:
        optionString(options, "compatibilityModel") ||
        optionString(options, "compatModel") ||
        undefined,
      skipStream: parseBooleanOption(options.skipStream),
      skipTool: parseBooleanOption(options.skipTool),
      log: (line) => console.log(line),
    });
    if (parseBooleanOption(options.json)) {
      console.log(JSON.stringify(summary, null, 2));
    }
    return;
  }

  throw new Error(
    "usage: opchat <provider-catalog|models|model|chat|smoke> [--env staging] [--opchat-api-base-url <url>]"
  );
}

async function getOpChatProviderCatalog(options: {
  apiBaseUrl: string;
  token: string;
}): Promise<unknown> {
  const apiBaseUrl = options.apiBaseUrl.trim().replace(/\/+$/, "");
  if (!apiBaseUrl) throw new Error("OpChat API base URL is required.");
  const token = options.token.trim();
  if (!token) throw new Error("OpenPond API key is required.");

  const response = await fetch(`${apiBaseUrl}/provider-catalog`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-openpond-client": "openpond-cli",
      "x-openpond-request-id": randomUUID(),
    },
  });
  if (!response.ok) {
    throw new Error(
      `Hosted provider catalog failed: ${response.status} ${await readResponseError(response)}`
    );
  }
  return response.json();
}

async function readResponseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return response.statusText || `HTTP ${response.status}`;
  try {
    const payload = JSON.parse(text) as {
      error?: unknown;
      message?: unknown;
    };
    if (typeof payload.message === "string") return payload.message;
    if (typeof payload.error === "string") return payload.error;
    if (
      payload.error &&
      typeof payload.error === "object" &&
      !Array.isArray(payload.error)
    ) {
      const error = payload.error as { code?: unknown; message?: unknown };
      return [error.code, error.message].filter(Boolean).join(": ") || text;
    }
    return text;
  } catch {
    return text;
  }
}

function resolveOpChatCliBaseUrl(
  config: {
    apiBaseUrl?: string;
    chatApiBaseUrl?: string;
  },
  options: Record<string, string | boolean>
): string {
  const envName =
    optionString(options, "env").toLowerCase() ||
    optionString(options, "environment").toLowerCase();
  const explicit =
    optionString(options, "opchatApiBaseUrl") ||
    optionString(options, "opchatApiBaseurl") ||
    optionString(options, "opChatApiBaseUrl") ||
    optionString(options, "opChatApiBaseurl") ||
    optionString(options, "opchatApiUrl") ||
    optionString(options, "opChatApiUrl");
  if (explicit) {
    return resolveOpChatApiBaseUrl({ opChatApiBaseUrl: explicit });
  }
  if (envName === "staging") {
    return STAGING_OPCHAT_API_BASE_URL;
  }
  if (envName && envName !== "production") {
    throw new Error("opchat env must be staging or production");
  }
  return resolveOpChatApiBaseUrl({
    apiBaseUrl: resolveApiBaseUrlOption(options) || config.apiBaseUrl,
    chatApiBaseUrl:
      resolveChatApiBaseUrlOption(options) || config.chatApiBaseUrl,
  });
}

function optionString(
  options: Record<string, string | boolean>,
  key: string
): string {
  const value = options[key];
  return typeof value === "string" ? value.trim() : "";
}
