import type { ConnectionBase } from "../api/api-client";

const connections = new WeakMap<ConnectionBase, { serverUrl: string; token: string; id: string }>();
const clients = new WeakMap<object, readonly string[]>();

/** Opaque identities isolate authorization changes without putting credentials
 * in query keys, persisted caches, devtools or rendered diagnostics. */
export function connectionQueryScope(connection: ConnectionBase | null): string {
  if (!connection) return "disconnected";
  let entry = connections.get(connection);
  if (!entry || entry.serverUrl !== connection.serverUrl || entry.token !== connection.token) {
    entry = { serverUrl: connection.serverUrl, token: connection.token, id: crypto.randomUUID() };
    connections.set(connection, entry);
  }
  return entry.id;
}

export function scopeLearningClient<T extends object>(client: T, scope: readonly string[]): T {
  clients.set(client, scope);
  return client;
}

export function learningQueryScope(client: object | null): readonly string[] {
  if (!client) return ["learning", "disconnected"];
  let scope = clients.get(client);
  if (!scope) { scope = ["learning", crypto.randomUUID()]; clients.set(client, scope); }
  return scope;
}
