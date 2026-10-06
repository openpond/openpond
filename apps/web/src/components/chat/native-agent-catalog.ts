import type { ProviderConfig, ProviderSettings } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";

type Option = { value: string; name: string };
export type NativeAgentCatalog = { error: string | null; settings: ProviderSettings; session: null | {
  modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string }> };
  configOptions?: Array<{ id: string; name: string; category?: string; currentValue: string; type: string; options?: Array<Option | { group: string; options: Option[] }> }>;
} };

type Pending = { controller: AbortController; promise: Promise<NativeAgentCatalog>; readers: number };
const requests = new WeakMap<ClientConnection, Map<string, Pending>>();
const catalogs = new WeakMap<ClientConnection, Map<string, { value: NativeAgentCatalog; refreshedAt: number }>>();
const CATALOG_REFRESH_MS = 30_000;

export function nativeAgentCatalogKey(provider: string, config?: ProviderConfig) {
  return JSON.stringify([provider, config?.binaryPath ?? null, config?.sourceHome ?? null, config?.enabled ?? true]);
}

/** Retain choices during refresh, but never across accounts or installations. */
export function cachedNativeAgentCatalog(connection: ClientConnection, provider: string, config?: ProviderConfig): NativeAgentCatalog | null {
  return catalogs.get(connection)?.get(nativeAgentCatalogKey(provider, config))?.value ?? null;
}

export function saveNativeAgentCatalog(connection: ClientConnection, provider: string, value: NativeAgentCatalog, config?: ProviderConfig) {
  let values = catalogs.get(connection);
  if (!values) { values = new Map(); catalogs.set(connection, values); }
  values.set(nativeAgentCatalogKey(provider, config), { value, refreshedAt: Date.now() });
}

/** Share active discovery; the last departing composer cancels its owned probe. */
export function acquireNativeAgentCatalog(connection: ClientConnection, provider: string, config?: ProviderConfig): { promise: Promise<NativeAgentCatalog>; release(): void } {
  const key = nativeAgentCatalogKey(provider, config);
  const retained = catalogs.get(connection)?.get(key);
  if (retained && Date.now() - retained.refreshedAt < CATALOG_REFRESH_MS) {
    return { promise: Promise.resolve(retained.value), release() {} };
  }
  let providers = requests.get(connection);
  if (!providers) { providers = new Map(); requests.set(connection, providers); }
  let pending = providers.get(key);
  if (!pending) {
    const controller = new AbortController();
    pending = { controller, readers: 0, promise: apiFetch<NativeAgentCatalog>(connection, `/v1/providers/${provider}/native-setup`, {
      method: "POST", body: JSON.stringify({ action: "capabilities" }), signal: controller.signal,
    }) };
    providers.set(key, pending);
    const current = pending;
    const settled = () => { if (providers.get(key) === current) providers.delete(key); };
    // Attach both outcomes immediately; an abandoned shared request cannot become
    // an unhandled rejection while its component cleanup cancels discovery.
    void pending.promise.then((value) => {
      if (providers.get(key) === current && !controller.signal.aborted && !value.error && value.session) {
        saveNativeAgentCatalog(connection, provider, value, config);
      }
      settled();
    }, settled);
  }
  pending.readers++;
  const current = pending;
  let released = false;
  return { promise: current.promise, release() {
    if (released) return;
    released = true;
    current.readers--;
    if (current.readers === 0 && providers.get(key) === current) {
      providers.delete(key);
      current.controller.abort();
    }
  } };
}
