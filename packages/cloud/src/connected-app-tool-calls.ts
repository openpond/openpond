import {
  CONNECTED_APP_TOOL_CALL_ENDPOINT,
  type ConnectedAppToolCallRequest,
  type ConnectedAppToolCallResponse,
} from "@openpond/connected-apps";
import { apiFetch } from "./api/core.js";

type ApiFetch = (
  baseUrl: string,
  token: string | null,
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export type ConnectedAppToolCallClientOptions = {
  path?: string;
  signal?: AbortSignal;
  apiFetch?: ApiFetch;
};

export type ConnectedAppToolCallClientResponse = ConnectedAppToolCallResponse & {
  status: number;
  endpointAvailable: boolean;
};

export type {
  ConnectedAppToolCallRequest,
  ConnectedAppToolCallResponse,
};

export { CONNECTED_APP_TOOL_CALL_ENDPOINT };

export async function executeConnectedAppToolCall(
  apiBaseUrl: string,
  apiKey: string,
  request: ConnectedAppToolCallRequest,
  options: ConnectedAppToolCallClientOptions = {},
): Promise<ConnectedAppToolCallClientResponse> {
  const response = await (options.apiFetch ?? apiFetch)(
    apiBaseUrl,
    apiKey,
    options.path ?? CONNECTED_APP_TOOL_CALL_ENDPOINT,
    {
      method: "POST",
      signal: options.signal,
      body: JSON.stringify(request),
    },
  );
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: unknown;
    output?: unknown;
    message?: unknown;
    error?: unknown;
    data?: unknown;
    result?: unknown;
  };
  const endpointAvailable = response.status !== 404 && response.status !== 405 && response.status !== 501;

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      endpointAvailable,
      output:
        responsePayloadMessage(payload) ??
        (endpointAvailable
          ? `Connected app tool call failed with status ${response.status}.`
          : `Connected app tool-call endpoint is not available (${response.status}).`),
      data: responsePayloadData(payload),
    };
  }

  return {
    ok: typeof payload.ok === "boolean" ? payload.ok : true,
    status: response.status,
    endpointAvailable,
    output: responsePayloadMessage(payload),
    data: responsePayloadData(payload),
  };
}

function responsePayloadMessage(payload: {
  output?: unknown;
  message?: unknown;
  error?: unknown;
}): string | null {
  if (typeof payload.output === "string" && payload.output.trim()) return payload.output.trim();
  if (typeof payload.message === "string" && payload.message.trim()) return payload.message.trim();
  if (typeof payload.error === "string" && payload.error.trim()) return payload.error.trim();
  return null;
}

function responsePayloadData(payload: { data?: unknown; result?: unknown }): unknown {
  if ("data" in payload) return payload.data;
  if ("result" in payload) return payload.result;
  return null;
}
