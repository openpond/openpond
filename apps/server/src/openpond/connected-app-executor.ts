import {
  apiFetch,
  DEFAULT_OPENPOND_API_BASE_URL,
  executeConnectedAppToolCall,
  normalizeSandboxApiUrl,
} from "@openpond/cloud";
import {
  CONNECTED_APP_TOOL_CALL_ENDPOINT,
  ConnectedAppToolCallRequestSchema,
} from "@openpond/contracts";
import { loadOpenPondAccountContext } from "@openpond/runtime";
import type {
  ConnectedAppToolExecutionRequest,
  ConnectedAppToolExecutionResult,
  ConnectedAppToolExecutor,
} from "./connected-app-tool-registry.js";

export const DEFAULT_CONNECTED_APP_TOOL_PATH = CONNECTED_APP_TOOL_CALL_ENDPOINT;

type ApiFetch = (
  baseUrl: string,
  token: string | null,
  path: string,
  init?: RequestInit,
) => Promise<Response>;

type LoadAccountContext = typeof loadOpenPondAccountContext;

export type CloudConnectedAppToolExecutorOptions = {
  env?: NodeJS.ProcessEnv;
  apiFetch?: ApiFetch;
  loadAccountContext?: LoadAccountContext;
};

export type CloudConnectedAppToolTarget = {
  apiBaseUrl: string;
  apiKey: string;
  path: string;
};

export function createCloudConnectedAppToolExecutor(
  options: CloudConnectedAppToolExecutorOptions = {},
): ConnectedAppToolExecutor {
  const env = options.env ?? process.env;
  const apiFetchImpl = options.apiFetch ?? apiFetch;
  const loadAccountContext = options.loadAccountContext ?? loadOpenPondAccountContext;

  return async (request, requestOptions) => {
    if (isDisabled(env.OPENPOND_CONNECTED_APP_TOOL_EXECUTOR)) {
      return connectorUnavailable(request.provider, "Cloud connected app execution is disabled.");
    }

    const payload = cloudConnectedAppToolPayload(request);
    const parsedPayload = ConnectedAppToolCallRequestSchema.safeParse(payload);
    if (!parsedPayload.success) {
      return connectorUnavailable(request.provider, connectedAppToolCallValidationMessage(parsedPayload.error));
    }

    let target: CloudConnectedAppToolTarget;
    try {
      target = await resolveCloudConnectedAppToolTarget({
        env,
        loadAccountContext,
      });
    } catch (error) {
      return connectorUnavailable(request.provider, errorMessage(error));
    }

    try {
      const payload = await executeConnectedAppToolCall(
        target.apiBaseUrl,
        target.apiKey,
        parsedPayload.data,
        {
          path: target.path,
          signal: requestOptions?.signal,
          apiFetch: apiFetchImpl,
        },
      );
      if (!payload.endpointAvailable) {
        return connectorUnavailable(
          request.provider,
          `Cloud connected app connector endpoint is not available (${payload.status}).`,
        );
      }
      return {
        ok: payload.ok,
        output: payload.output,
        data: payload.data,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      return connectorUnavailable(
        request.provider,
        `Cloud connected app connector request failed: ${errorMessage(error)}`,
      );
    }
  };
}

export async function resolveCloudConnectedAppToolTarget(
  options: Pick<
    CloudConnectedAppToolExecutorOptions,
    "env" | "loadAccountContext"
  > = {},
): Promise<CloudConnectedAppToolTarget> {
  const env = options.env ?? process.env;
  const path = normalizeToolPath(env.OPENPOND_CONNECTED_APP_TOOL_PATH);
  const apiKey =
    env.OPENPOND_CONNECTED_APP_API_KEY?.trim() ||
    env.OPENPOND_SANDBOX_API_KEY?.trim() ||
    env.OPENPOND_API_KEY?.trim();

  if (apiKey) {
    return {
      apiBaseUrl: resolveCloudConnectedAppApiBaseUrl(env, null),
      apiKey,
      path,
    };
  }

  const loadAccountContext = options.loadAccountContext ?? loadOpenPondAccountContext;
  const context = await loadAccountContext();
  const token = context.token?.trim();
  if (!token) {
    throw new Error("OpenPond account API key is required for connected app connector execution.");
  }

  return {
    apiBaseUrl: resolveCloudConnectedAppApiBaseUrl(env, context.apiBaseUrl),
    apiKey: token,
    path,
  };
}

function resolveCloudConnectedAppApiBaseUrl(
  env: NodeJS.ProcessEnv,
  accountApiBaseUrl: string | null | undefined,
): string {
  return (
    normalizeApiBaseUrl(env.OPENPOND_CONNECTED_APP_API_URL) ??
    apiBaseUrlFromSandboxApiUrl(env.OPENPOND_SANDBOX_API_URL) ??
    normalizeApiBaseUrl(env.OPENPOND_SANDBOX_BASE_URL) ??
    normalizeApiBaseUrl(env.OPENPOND_API_URL) ??
    normalizeApiBaseUrl(accountApiBaseUrl) ??
    DEFAULT_OPENPOND_API_BASE_URL
  );
}

function cloudConnectedAppToolPayload(
  request: ConnectedAppToolExecutionRequest,
): Record<string, unknown> {
  return {
    provider: request.provider,
    operation: request.operation,
    toolName: request.toolName,
    sessionId: request.sessionId,
    turnId: request.turnId,
    userPrompt: request.userPrompt,
    connectionIds: request.connectionIds,
    capabilityIds: request.capabilityIds,
    args: request.args,
  };
}

function apiBaseUrlFromSandboxApiUrl(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalUrl(value);
  if (!normalized) return null;
  return normalizeApiBaseUrl(normalizeSandboxApiUrl(normalized));
}

function normalizeApiBaseUrl(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    url.pathname = normalizeApiBasePath(url.pathname);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return normalized
      .replace(/\/v1\/sandboxes\/?$/i, "")
      .replace(/\/api\/sandboxes\/?$/i, "")
      .replace(/\/sandboxes\/?$/i, "")
      .replace(/\/v1\/?$/i, "")
      .replace(/\/+$/, "");
  }
}

function normalizeApiBasePath(pathname: string): string {
  let path = pathname.replace(/\/+$/, "");
  path = path
    .replace(/\/v1\/sandboxes$/i, "")
    .replace(/\/api\/sandboxes$/i, "")
    .replace(/\/sandboxes$/i, "")
    .replace(/\/v1$/i, "");
  return path || "/";
}

function normalizeOptionalUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

function normalizeToolPath(value: string | null | undefined): string {
  const normalized = value?.trim() || DEFAULT_CONNECTED_APP_TOOL_PATH;
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function connectorUnavailable(
  provider: string,
  reason: string,
): ConnectedAppToolExecutionResult {
  return {
    ok: false,
    output: `${reason} No ${provider} provider API call was made.`,
  };
}

function isDisabled(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off" || normalized === "disabled";
}

function connectedAppToolCallValidationMessage(error: { issues?: Array<{ message: string }> }): string {
  return error.issues?.[0]?.message ?? "Connected app tool call request is invalid.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
