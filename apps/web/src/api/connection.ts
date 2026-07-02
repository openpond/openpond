import type { ClientConnection, ConnectionBase } from "./api-client";

const SERVER_URL_STORAGE_KEY = "openpond-app-server-url";
const TOKEN_STORAGE_KEY = "openpond-app-token";
const CONNECTION_HEALTH_TIMEOUT_MS = 750;

function sameOriginServerUrl(): string | null {
  if (window.location.protocol !== "http:" && window.location.protocol !== "https:") return null;
  return window.location.origin && window.location.origin !== "null"
    ? window.location.origin
    : null;
}

function readStoredConnection(storage: Storage): ConnectionBase | null {
  const serverUrl = storage.getItem(SERVER_URL_STORAGE_KEY)?.trim();
  const token = storage.getItem(TOKEN_STORAGE_KEY)?.trim();
  return serverUrl && token ? { serverUrl, token } : null;
}

function writeStoredConnection(storage: Storage, connection: ConnectionBase): void {
  storage.setItem(SERVER_URL_STORAGE_KEY, connection.serverUrl);
  storage.setItem(TOKEN_STORAGE_KEY, connection.token);
}

function clearStoredConnection(storage: Storage, connection: ConnectionBase): void {
  const stored = readStoredConnection(storage);
  if (stored?.serverUrl !== connection.serverUrl || stored.token !== connection.token) return;
  storage.removeItem(SERVER_URL_STORAGE_KEY);
  storage.removeItem(TOKEN_STORAGE_KEY);
}

function connectionFromInjectedWebConfig(): ConnectionBase | null {
  const injected = window.__OPENPOND_WEB_CONNECTION__;
  const serverUrl = injected?.serverUrl?.trim();
  const token = injected?.token?.trim();
  return serverUrl && token ? { serverUrl, token } : null;
}

function connectionFromDevHash(): ConnectionBase | null {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const token = params.get("openpondToken")?.trim();
  const serverUrl = params.get("openpondServerUrl")?.trim() || sameOriginServerUrl();
  if (!serverUrl || !token) return null;
  return { serverUrl, token };
}

function clearConnectionHash(): void {
  if (!window.location.hash) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

function addCandidate(candidates: ConnectionBase[], candidate: ConnectionBase | null): void {
  if (!candidate) return;
  if (
    candidates.some(
      (current) => current.serverUrl === candidate.serverUrl && current.token === candidate.token,
    )
  )
    return;
  candidates.push(candidate);
}

function connectionCandidates(): ConnectionBase[] {
  const candidates: ConnectionBase[] = [];
  addCandidate(
    candidates,
    import.meta.env.VITE_OPENPOND_SERVER_URL && import.meta.env.VITE_OPENPOND_TOKEN
      ? {
          serverUrl: import.meta.env.VITE_OPENPOND_SERVER_URL,
          token: import.meta.env.VITE_OPENPOND_TOKEN,
        }
      : null,
  );
  addCandidate(
    candidates,
    sameOriginServerUrl() &&
      (window.sessionStorage.getItem(TOKEN_STORAGE_KEY) ||
        window.localStorage.getItem(TOKEN_STORAGE_KEY))
      ? {
          serverUrl: sameOriginServerUrl()!,
          token:
            window.sessionStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ||
            window.localStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ||
            "",
        }
      : null,
  );
  addCandidate(candidates, readStoredConnection(window.sessionStorage));
  addCandidate(candidates, readStoredConnection(window.localStorage));
  return candidates;
}

async function serverIsReachable(serverUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), CONNECTION_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${serverUrl}/health`, { signal: controller.signal });
    const payload = (await response.json().catch(() => null)) as { server?: unknown } | null;
    return response.ok && payload?.server === "openpond-app-server";
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function resolveConnection(): Promise<ClientConnection> {
  if (window.openpond) return window.openpond.getConnection();
  const devHashConnection = connectionFromDevHash();
  if (devHashConnection && (await serverIsReachable(devHashConnection.serverUrl))) {
    writeStoredConnection(window.localStorage, devHashConnection);
    writeStoredConnection(window.sessionStorage, devHashConnection);
    clearConnectionHash();
    return {
      ...devHashConnection,
      platform: navigator.platform,
    };
  }
  const injectedConnection = connectionFromInjectedWebConfig();
  if (injectedConnection && (await serverIsReachable(injectedConnection.serverUrl))) {
    writeStoredConnection(window.localStorage, injectedConnection);
    writeStoredConnection(window.sessionStorage, injectedConnection);
    return {
      ...injectedConnection,
      platform: navigator.platform,
    };
  }
  const candidates = connectionCandidates();
  for (const candidate of candidates) {
    if (await serverIsReachable(candidate.serverUrl)) {
      writeStoredConnection(window.localStorage, candidate);
      writeStoredConnection(window.sessionStorage, candidate);
      return {
        ...candidate,
        platform: navigator.platform,
      };
    }
    clearStoredConnection(window.sessionStorage, candidate);
    clearStoredConnection(window.localStorage, candidate);
  }
  throw new Error(
    "No reachable OpenPond app server. Start `openpond ui` again and open the full printed URL.",
  );
}
