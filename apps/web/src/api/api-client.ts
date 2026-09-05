export type ClientConnection = {
  serverUrl: string;
  token: string;
  platform: string;
  arch?: string;
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

const preferenceRevisions = new WeakMap<ClientConnection, string>();
const responseOrders = new WeakMap<ClientConnection, number>();
const preferenceWrites = new WeakMap<ClientConnection, Promise<unknown>>();
let requestOrder = 0;

export async function apiFetch<T>(
  connection: ClientConnection,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (path === "/v1/preferences" && typeof init?.body === "string") {
    const previous = preferenceWrites.get(connection) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(() => performFetch<T>(connection, path, init));
    preferenceWrites.set(connection, write);
    try { return await write; }
    finally { if (preferenceWrites.get(connection) === write) preferenceWrites.delete(connection); }
  }
  return performFetch<T>(connection, path, init);
}

async function performFetch<T>(connection: ClientConnection, path: string, init?: RequestInit): Promise<T> {
  const order = ++requestOrder;
  if (path === "/v1/preferences" && typeof init?.body === "string") {
    const expectedRevision = preferenceRevisions.get(connection);
    if (!expectedRevision) throw new Error("Reload settings before saving so changes can be checked against the current file.");
    init = { ...init, body: JSON.stringify({ expectedRevision, ...JSON.parse(init.body) }) };
  }
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
  const payload = await response.json();
  const revision = payload?.configuration?.rawRevision ?? (path === "/v1/preferences" ? payload?.rawRevision : undefined);
  if (typeof revision === "string" && order >= (responseOrders.get(connection) ?? 0)) {
    preferenceRevisions.set(connection, revision); responseOrders.set(connection, order);
  }
  return payload as T;
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
