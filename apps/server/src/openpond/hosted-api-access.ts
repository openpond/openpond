import { loadOpenPondAccountContext, type RuntimeAccountContext } from "@openpond/runtime";

const DEFAULT_OPENPOND_API_BASE_URL = "https://api.openpond.ai";

export type HostedApiAccessDependencies = {
  loadAccountContext?: () => Promise<RuntimeAccountContext>;
};

export async function resolveHostedApiAccess(
  dependencies: HostedApiAccessDependencies = {},
): Promise<{ apiBaseUrl: string; token: string }> {
  const context = await (dependencies.loadAccountContext ?? loadOpenPondAccountContext)();
  const token = process.env.OPENPOND_SANDBOX_API_KEY?.trim() || context.token?.trim();
  if (!token) throw new Error("OpenPond account API key is required.");
  return { apiBaseUrl: resolveApiBaseUrl(context), token };
}

export function hostedApiAuthHeaders(token: string): Headers {
  const headers = new Headers();
  if (token.startsWith("opk_")) {
    headers.set("Authorization", `ApiKey ${token}`);
    headers.set("openpond-api-key", token);
  } else {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

function resolveApiBaseUrl(context: RuntimeAccountContext): string {
  return (
    normalizeOptionalUrl(process.env.OPENPOND_API_URL) ??
    apiBaseUrlFromSandboxApiUrl(process.env.OPENPOND_SANDBOX_API_URL) ??
    normalizeOptionalUrl(context.apiBaseUrl) ??
    normalizeOptionalUrl(context.account?.apiBaseUrl) ??
    normalizeOptionalUrl(context.config.apiBaseUrl) ??
    normalizeOpenPondWebBaseAsApi(context.account?.baseUrl) ??
    normalizeOpenPondWebBaseAsApi(context.config.baseUrl) ??
    DEFAULT_OPENPOND_API_BASE_URL
  );
}

export function apiBaseUrlFromSandboxApiUrl(value?: string | null): string | null {
  const normalized = normalizeOptionalUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    url.pathname =
      url.pathname
        .replace(/\/(?:v1|api)\/sandboxes\/?$/i, "")
        .replace(/\/sandboxes\/?$/i, "")
        .replace(/\/v1\/?$/i, "") || "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return normalized
      .replace(/\/(?:v1|api)\/sandboxes\/?$/i, "")
      .replace(/\/sandboxes\/?$/i, "")
      .replace(/\/v1\/?$/i, "")
      .replace(/\/+$/, "");
  }
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
