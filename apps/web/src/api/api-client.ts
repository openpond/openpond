export type ClientConnection = {
  serverUrl: string;
  token: string;
  platform: string;
};

export type ConnectionBase = Pick<ClientConnection, "serverUrl" | "token">;

export type SandboxScopeInput = {
  teamId?: string;
  projectId?: string;
  agentId?: string;
};

export function sandboxScopeQuery(input: SandboxScopeInput = {}): URLSearchParams {
  const query = new URLSearchParams();
  if (input.teamId) query.set("teamId", input.teamId);
  if (input.projectId) query.set("projectId", input.projectId);
  if (input.agentId) query.set("agentId", input.agentId);
  return query;
}

export async function apiFetch<T>(
  connection: ClientConnection,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${connection.token}`);
  const response = await fetch(`${connection.serverUrl}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : response.statusText;
    throw new Error(error);
  }
  return (await response.json()) as T;
}

export {
  openEventStream,
  readRuntimeEventStream,
  runtimeEventReconnectDelayMs,
  runtimeEventStreamRequest,
  validateRuntimeEventResponse,
  type RuntimeEventStreamHandle,
} from "./event-stream";

export function terminalWebSocketUrl(connection: ClientConnection): string {
  const url = new URL("/v1/terminal", connection.serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function terminalWebSocketProtocols(connection: ClientConnection): string[] {
  return ["openpond-terminal", `openpond-token.${textToBase64Url(connection.token)}`];
}

export function textToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    const chunk = bytes.subarray(index, index + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function textToBase64Url(value: string): string {
  return textToBase64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64ToText(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}
