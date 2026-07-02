import { loadOpenPondAccountContext } from "@openpond/runtime";
import type { RuntimeAccountContext } from "@openpond/runtime";

export type OrganizationRequestAction =
  | { type: "list" }
  | { type: "create"; payload: unknown }
  | { type: "get"; slug: string }
  | { type: "update"; slug: string; payload: unknown }
  | { type: "members"; slug: string }
  | { type: "member_upsert"; slug: string; payload: unknown }
  | { type: "mcp_get"; slug: string }
  | { type: "mcp_generate"; slug: string; payload: unknown }
  | { type: "mcp_rotate"; slug: string }
  | { type: "mcp_disable"; slug: string }
  | { type: "mcp_enable"; slug: string };

const DEFAULT_OPENPOND_API_BASE_URL = "https://api.openpond.ai";

export async function organizationRequestPayload(
  action: OrganizationRequestAction,
): Promise<unknown> {
  const context = await loadOpenPondAccountContext();
  const token = context.token?.trim();
  if (!token) {
    throw new Error("OpenPond account API key is required to manage organizations.");
  }
  const apiBaseUrl = resolveApiBaseUrl(context);

  if (action.type === "list") {
    return openPondApiRequest(apiBaseUrl, token, "/v1/organizations");
  }
  if (action.type === "create") {
    return openPondApiRequest(apiBaseUrl, token, "/v1/organizations", {
      method: "POST",
      body: JSON.stringify(action.payload ?? {}),
    });
  }
  if (action.type === "get") {
    return openPondApiRequest(
      apiBaseUrl,
      token,
      `/v1/organizations/${encodeURIComponent(action.slug)}`,
    );
  }
  if (action.type === "update") {
    return openPondApiRequest(
      apiBaseUrl,
      token,
      `/v1/organizations/${encodeURIComponent(action.slug)}`,
      {
        method: "PATCH",
        body: JSON.stringify(action.payload ?? {}),
      },
    );
  }
  if (action.type === "members") {
    return openPondApiRequest(
      apiBaseUrl,
      token,
      `/v1/organizations/${encodeURIComponent(action.slug)}/members`,
    );
  }
  if (action.type === "member_upsert") {
    return openPondApiRequest(
      apiBaseUrl,
      token,
      `/v1/organizations/${encodeURIComponent(action.slug)}/members`,
      {
        method: "POST",
        body: JSON.stringify(action.payload ?? {}),
      },
    );
  }
  if (action.type === "mcp_get") {
    return openPondApiRequest(
      apiBaseUrl,
      token,
      `/v1/organizations/${encodeURIComponent(action.slug)}/mcp-server`,
    );
  }
  if (action.type === "mcp_generate") {
    return openPondApiRequest(
      apiBaseUrl,
      token,
      `/v1/organizations/${encodeURIComponent(action.slug)}/mcp-server`,
      {
        method: "POST",
        body: JSON.stringify(action.payload ?? {}),
      },
    );
  }
  if (action.type === "mcp_rotate") {
    return openPondApiRequest(
      apiBaseUrl,
      token,
      `/v1/organizations/${encodeURIComponent(action.slug)}/mcp-server/rotate`,
      { method: "POST" },
    );
  }
  if (action.type === "mcp_disable") {
    return openPondApiRequest(
      apiBaseUrl,
      token,
      `/v1/organizations/${encodeURIComponent(action.slug)}/mcp-server/disable`,
      { method: "POST" },
    );
  }
  if (action.type === "mcp_enable") {
    return openPondApiRequest(
      apiBaseUrl,
      token,
      `/v1/organizations/${encodeURIComponent(action.slug)}/mcp-server/enable`,
      { method: "POST" },
    );
  }
  throw new Error(`Unsupported organization action: ${(action as { type: string }).type}`);
}

async function openPondApiRequest(
  apiBaseUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token.startsWith("opk_")) {
    headers.set("Authorization", `ApiKey ${token}`);
    headers.set("openpond-api-key", token);
  } else {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    message?: unknown;
  };
  if (!response.ok) {
    const message =
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.error === "string"
          ? payload.error
          : response.statusText;
    throw new Error(message);
  }
  return payload;
}

function resolveApiBaseUrl(context: RuntimeAccountContext): string {
  return (
    normalizeOptionalUrl(process.env.OPENPOND_API_URL) ??
    normalizeOptionalUrl(context.apiBaseUrl) ??
    normalizeOptionalUrl(context.account?.apiBaseUrl) ??
    normalizeOptionalUrl(context.config.apiBaseUrl) ??
    normalizeOpenPondWebBaseAsApi(context.account?.baseUrl) ??
    normalizeOpenPondWebBaseAsApi(context.config.baseUrl) ??
    DEFAULT_OPENPOND_API_BASE_URL
  );
}

function normalizeOpenPondWebBaseAsApi(value?: string | null): string | null {
  const normalized = normalizeOptionalUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.hostname === "openpond.ai") return "https://api.openpond.ai";
    if (!url.hostname.startsWith("api.") && url.hostname.endsWith(".openpond.ai")) {
      url.hostname = `api.${url.hostname}`;
      return url.origin;
    }
  } catch {
    return normalized;
  }
  return normalized;
}

function normalizeOptionalUrl(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, "") : null;
}
