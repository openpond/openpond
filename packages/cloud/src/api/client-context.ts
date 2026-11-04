import { AsyncLocalStorage } from "node:async_hooks";

const clientIdentity = new AsyncLocalStorage<string>();

/** Identify a caller within this async operation without changing global fetch
 * or propagating CLI identity to separately launched desktop/server processes. */
export function withApiClientIdentity<T>(identity: string, operation: () => T): T {
  return clientIdentity.run(identity, operation);
}

export function apiClientIdentity(): string | undefined {
  return clientIdentity.getStore();
}
