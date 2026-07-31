import { loadOpenPondAccountContext, type RuntimeAccountContext } from "@openpond/runtime";

const DEFAULT_OPENPOND_API_BASE_URL = "https://api.openpond.ai";

export type HostedApiAccessDependencies = {
  loadAccountContext?: () => Promise<RuntimeAccountContext>;
  teamId?: string | null;
};

export async function resolveHostedApiAccess(
  dependencies: HostedApiAccessDependencies = {},
): Promise<{ apiBaseUrl: string; token: string }> {
  const context = await (dependencies.loadAccountContext ?? loadOpenPondAccountContext)();
  const token = context.token?.trim();
  if (!token) throw new Error("OpenPond account API key is required.");
  return { apiBaseUrl: resolveApiBaseUrl(context), token };
}

export async function resolveManagedAdapterUserAccess(
  dependencies: HostedApiAccessDependencies = {},
): Promise<{ apiBaseUrl: string; token: string; teamId: string }> {
  const access = await resolveHostedApiAccess(dependencies);
  return { ...access, teamId: managedAdapterTeamId(dependencies.teamId) };
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

function managedAdapterTeamId(explicitTeamId?: string | null): string {
  const teamId = explicitTeamId?.trim();
  if (!teamId || !/^[A-Za-z0-9_-]{3,191}$/.test(teamId)) {
    throw new Error("Select an OpenPond workspace before using OpenPond Managed RL.");
  }
  return teamId;
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
