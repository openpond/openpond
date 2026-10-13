import type { ConnectionBase } from "./api-client";

export const CONNECTION_MESSAGE = "Couldn’t connect to OpenPond.";
export type ConnectionStatus = { error: string | null; outage: number; recovery: number };
const connected: ConnectionStatus = { error: null, outage: 0, recovery: 0 };
type Entry = { status: ConnectionStatus; listeners: Set<() => void> };
const entries = new Map<string, Entry>();

function entry(connection: ConnectionBase): Entry {
  const key = JSON.stringify([connection.serverUrl.replace(/\/$/, ""), connection.token]);
  let value = entries.get(key);
  if (!value) { value = { status: connected, listeners: new Set() }; entries.set(key, value); }
  return value;
}

export function connectionStatus(connection: ConnectionBase | null): ConnectionStatus {
  return connection ? entry(connection).status : connected;
}

export function subscribeConnectionStatus(connection: ConnectionBase | null, listener: () => void): () => void {
  if (!connection) return () => {};
  const value = entry(connection);
  value.listeners.add(listener);
  return () => { value.listeners.delete(listener); };
}

/** Ignore requests from before a completed recovery; a late failure cannot reopen it. */
export function reportConnectionFailure(connection: ConnectionBase, recovery = connectionStatus(connection).recovery): void {
  const value = entry(connection);
  if (value.status.error || recovery !== value.status.recovery) return;
  value.status = { ...value.status, error: CONNECTION_MESSAGE, outage: value.status.outage + 1 };
  value.listeners.forEach(listener => listener());
}

export function reportConnectionRestored(connection: ConnectionBase): void {
  const value = entry(connection);
  if (!value.status.error) return;
  value.status = { ...value.status, error: null, recovery: value.status.recovery + 1 };
  value.listeners.forEach(listener => listener());
}

export class ConnectionRequestError extends Error {
  constructor(cause: unknown) {
    super(CONNECTION_MESSAGE, { cause });
    this.name = "ConnectionRequestError";
  }
}
