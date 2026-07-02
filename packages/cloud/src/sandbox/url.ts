import {
  DEFAULT_OPENPOND_API_BASE_URL,
  DEFAULT_OPENPOND_WEB_BASE_URL,
} from "../urls.js";

export function normalizeSandboxApiUrl(baseUrlOrApiUrl: string): string {
  const trimmed = baseUrlOrApiUrl.trim().replace(/\/$/, "");
  if (!trimmed) {
    throw new Error("sandbox API URL must be non-empty");
  }
  const url = new URL(trimmed);
  const normalizedPath = url.pathname.replace(/\/$/, "");
  if (
    normalizedPath.endsWith("/v1/sandboxes") ||
    normalizedPath.endsWith("/api/sandboxes")
  ) {
    return `${url.origin}${normalizedPath}`;
  }
  if (normalizedPath.endsWith("/v1")) {
    return `${url.origin}${normalizedPath}/sandboxes`;
  }
  if (isOpenPondHostedApiHost(url.hostname)) {
    return `${url.origin}${normalizedPath}/v1/sandboxes`;
  }
  if (url.origin === DEFAULT_OPENPOND_WEB_BASE_URL) {
    return `${DEFAULT_OPENPOND_API_BASE_URL}/v1/sandboxes`;
  }
  return `${url.origin}${normalizedPath}/api/sandboxes`;
}

export function apiRootUrlFromSandboxApiUrl(sandboxApiUrl: string): string {
  const suffix = "/sandboxes";
  if (!sandboxApiUrl.endsWith(suffix)) {
    throw new Error("sandbox API URL must end with /sandboxes");
  }
  return sandboxApiUrl.slice(0, -suffix.length);
}

function isOpenPondHostedApiHost(hostname: string): boolean {
  return (
    hostname === "api.openpond.ai" ||
    (hostname.startsWith("api") && hostname.endsWith(".openpond.ai"))
  );
}
