import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  DesktopHarnessApi,
  DesktopHarnessConnection,
  DesktopHarnessRuntimeEvent,
} from "./types.js";

export class DesktopHarnessApiClient implements DesktopHarnessApi {
  constructor(readonly connection: DesktopHarnessConnection | null) {}

  get connected(): boolean {
    return Boolean(this.connection);
  }

  async health<T = Record<string, unknown>>(): Promise<T> {
    return this.fetchJson<T>("/health");
  }

  async bootstrap<T = Record<string, unknown>>(query = "ensureProfile=0"): Promise<T> {
    return this.fetchJson<T>(`/v1/bootstrap${query ? `?${query}` : ""}`);
  }

  async eventPage<T = Record<string, unknown>>(params: {
    sessionId?: string;
    afterSequence?: number;
    limit?: number;
  } = {}): Promise<T> {
    return this.fetchJson<T>("/v1/events/page", {
      query: {
        sessionId: params.sessionId,
        afterSequence: params.afterSequence,
        limit: params.limit,
      },
    });
  }

  async usageRecords<T = Record<string, unknown>>(params: { range?: string; limit?: number } = {}): Promise<T> {
    return this.fetchJson<T>("/v1/usage/records", {
      query: {
        range: params.range ?? "all",
        limit: params.limit,
      },
    });
  }

  async createSession<T = Record<string, unknown>>(payload: Record<string, unknown>): Promise<T> {
    return this.fetchJson<T>("/v1/sessions", { method: "POST", body: payload });
  }

  async createTurn<T = Record<string, unknown>>(sessionId: string, payload: Record<string, unknown>): Promise<T> {
    return this.fetchJson<T>(`/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
      method: "POST",
      body: payload,
    });
  }

  async fetchJson<T = Record<string, unknown>>(
    pathOrUrl: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | null | undefined> } = {},
  ): Promise<T> {
    const connection = this.requireConnection();
    const url = urlForRequest(connection.serverUrl, pathOrUrl, init.query);
    const response = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${redactUrl(url)} returned HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private requireConnection(): DesktopHarnessConnection {
    if (!this.connection) throw new Error("Desktop harness API is not connected. Use --attach or --isolated.");
    return this.connection;
  }
}

export async function readHarnessToken(input: {
  token?: string | null;
  tokenFile?: string | null;
  defaultTokenFile?: string;
}): Promise<string | null> {
  if (input.token?.trim()) return input.token.trim();
  const tokenFile = input.tokenFile || input.defaultTokenFile;
  if (!tokenFile) return null;
  try {
    return (await readFile(path.resolve(tokenFile), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

export async function fetchSessionEvents(
  api: DesktopHarnessApi,
  sessionId: string,
): Promise<DesktopHarnessRuntimeEvent[]> {
  const bootstrap = await api.bootstrap<{ events?: DesktopHarnessRuntimeEvent[] }>();
  return (bootstrap.events ?? []).filter((event) => event.sessionId === sessionId);
}

export function urlForRequest(
  serverUrl: string,
  pathOrUrl: string,
  query?: Record<string, string | number | boolean | null | undefined>,
): string {
  const url = pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
    ? new URL(pathOrUrl)
    : new URL(pathOrUrl, serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}
