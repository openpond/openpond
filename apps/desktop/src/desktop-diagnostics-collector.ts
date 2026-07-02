import { Buffer } from "node:buffer";
import type { DesktopRequestDiagnosticsSnapshot } from "./desktop-request-tracker.js";
import type { ProcessTreeSamplerSnapshot } from "./desktop-process-sampler.js";

export type DesktopDiagnosticsSummary = {
  app: string;
  version: string;
  releaseChannel: string;
  packaged: boolean;
  platform: string;
  arch: string;
  appHome: string;
  logDir: string;
  createdAt: string;
};

export type DesktopDiagnosticsServerConnection = {
  serverUrl: string;
  token: string;
};

export type DesktopDiagnosticsLogSummary = {
  lineLimit: number;
  lines: number;
};

export type DesktopDiagnosticsRequestSummary = {
  localRpc?: DesktopRequestDiagnosticsSnapshot;
};

export type DesktopDiagnosticsResourceSummary = {
  serverProcess?: ProcessTreeSamplerSnapshot;
};

export type DesktopDiagnosticsSnapshot = {
  desktop: DesktopDiagnosticsSummary;
  server: {
    configured: boolean;
    serverUrl?: string;
    health?: DesktopDiagnosticsRouteResult;
    bootstrap?: DesktopDiagnosticsRouteResult;
    providers?: DesktopDiagnosticsRouteResult;
    store?: DesktopDiagnosticsStoreMetadata;
  };
  requests?: DesktopDiagnosticsRequestSummary;
  resources?: DesktopDiagnosticsResourceSummary;
  logs: DesktopDiagnosticsLogSummary;
};

export type DesktopDiagnosticsRouteResult = {
  ok: boolean;
  status: number | null;
  durationMs: number;
  responseBytes: number;
  error?: string;
  payload?: Record<string, unknown>;
};

export type DesktopDiagnosticsStoreMetadata = {
  storePath?: string;
  serverId?: string;
  host?: string;
  port?: number;
  startedAt?: string;
  version?: string;
  runtimeVersion?: string;
};

type DiagnosticsFetch = typeof fetch;

export async function collectDesktopDiagnostics(input: {
  desktop: DesktopDiagnosticsSummary;
  serverConnection?: DesktopDiagnosticsServerConnection | null;
  requests?: DesktopDiagnosticsRequestSummary;
  resources?: DesktopDiagnosticsResourceSummary;
  logs: DesktopDiagnosticsLogSummary;
  fetchImpl?: DiagnosticsFetch;
  now?: () => number;
}): Promise<DesktopDiagnosticsSnapshot> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const nowMs = input.now ?? (() => Date.now());
  const serverUrl = normalizeServerUrl(input.serverConnection?.serverUrl ?? null);
  if (!serverUrl || !input.serverConnection?.token) {
    return {
      desktop: input.desktop,
      server: { configured: false },
      ...(input.requests ? { requests: input.requests } : {}),
      ...(input.resources ? { resources: input.resources } : {}),
      logs: input.logs,
    };
  }

  const health = await collectRouteResult({
    fetchImpl,
    now: nowMs,
    url: new URL("/health", serverUrl).toString(),
  });
  const bootstrap = await collectRouteResult({
    fetchImpl,
    now: nowMs,
    url: new URL("/v1/bootstrap?ensureProfile=0", serverUrl).toString(),
    headers: { Authorization: `Bearer ${input.serverConnection.token}` },
  });
  const providers = await collectRouteResult({
    fetchImpl,
    now: nowMs,
    url: new URL("/v1/diagnostics/providers", serverUrl).toString(),
    headers: { Authorization: `Bearer ${input.serverConnection.token}` },
  });

  return {
    desktop: input.desktop,
    server: {
      configured: true,
      serverUrl,
      health,
      bootstrap,
      providers,
      store: storeMetadataFromBootstrap(bootstrap.payload),
    },
    ...(input.requests ? { requests: input.requests } : {}),
    ...(input.resources ? { resources: input.resources } : {}),
    logs: input.logs,
  };
}

async function collectRouteResult(input: {
  fetchImpl: DiagnosticsFetch;
  now: () => number;
  url: string;
  headers?: HeadersInit;
}): Promise<DesktopDiagnosticsRouteResult> {
  const started = input.now();
  try {
    const response = await input.fetchImpl(input.url, {
      headers: input.headers,
    });
    const text = await response.text();
    const payload = parseJsonRecord(text);
    return {
      ok: response.ok,
      status: response.status,
      durationMs: Math.max(0, input.now() - started),
      responseBytes: Buffer.byteLength(text, "utf8"),
      ...(payload ? { payload } : {}),
      ...(!response.ok ? { error: payloadError(payload) ?? response.statusText } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      durationMs: Math.max(0, input.now() - started),
      responseBytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeServerUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function payloadError(payload: Record<string, unknown> | undefined): string | undefined {
  const error = payload?.error;
  const message = payload?.message;
  if (typeof message === "string" && message.trim()) return message;
  if (typeof error === "string" && error.trim()) return error;
  return undefined;
}

function storeMetadataFromBootstrap(
  payload: Record<string, unknown> | undefined,
): DesktopDiagnosticsStoreMetadata | undefined {
  const server = payload?.server;
  if (!server || typeof server !== "object" || Array.isArray(server)) return undefined;
  const record = server as Record<string, unknown>;
  const metadata: DesktopDiagnosticsStoreMetadata = {
    storePath: stringValue(record.storePath),
    serverId: stringValue(record.id),
    host: stringValue(record.host),
    port: numberValue(record.port),
    startedAt: stringValue(record.startedAt),
    version: stringValue(record.version),
    runtimeVersion: stringValue(record.runtimeVersion),
  };
  return Object.values(metadata).some((value) => value !== undefined) ? metadata : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
