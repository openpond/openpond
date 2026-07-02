import type { LocalConfig } from "../../config";
import {
  DEFAULT_OPENPOND_API_BASE_URL,
  DEFAULT_OPENPOND_WEB_BASE_URL,
} from "../../urls";

export const DEFAULT_OPENPOND_API_HOST = new URL(DEFAULT_OPENPOND_API_BASE_URL)
  .hostname;
export const DEFAULT_OPENPOND_WEB_HOST = new URL(DEFAULT_OPENPOND_WEB_BASE_URL)
  .hostname;

export function resolveAccountOption(
  options: Record<string, string | boolean>
): string | null {
  const raw =
    typeof options.account === "string"
      ? options.account
      : typeof options.profile === "string"
      ? options.profile
      : null;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "true") {
    throw new Error("account must be a non-empty value");
  }
  return trimmed;
}

export function resolveBaseUrlOption(
  options: Record<string, string | boolean>
): string | null {
  const raw =
    typeof options.baseUrl === "string"
      ? options.baseUrl
      : typeof options.baseurl === "string"
      ? options.baseurl
      : null;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "true") {
    throw new Error("baseurl must be a non-empty value");
  }
  return trimmed.replace(/\/$/, "");
}

export function resolveApiBaseUrlOption(
  options: Record<string, string | boolean>
): string | null {
  const raw =
    typeof options.apiBaseUrl === "string"
      ? options.apiBaseUrl
      : typeof options.apiBaseurl === "string"
      ? options.apiBaseurl
      : null;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "true") {
    throw new Error("api-base-url must be a non-empty value");
  }
  return trimmed.replace(/\/$/, "");
}

export function resolveChatApiBaseUrlOption(
  options: Record<string, string | boolean>
): string | null {
  const raw =
    typeof options.chatApiBaseUrl === "string"
      ? options.chatApiBaseUrl
      : typeof options.chatApiBaseurl === "string"
      ? options.chatApiBaseurl
      : typeof options.chatApiUrl === "string"
      ? options.chatApiUrl
      : null;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "true") {
    throw new Error("chat-api-base-url must be a non-empty value");
  }
  return trimmed.replace(/\/$/, "");
}

export function resolveSandboxApiUrlOption(
  options: Record<string, string | boolean>
): string | null {
  const raw =
    typeof options.sandboxApiUrl === "string"
      ? options.sandboxApiUrl
      : typeof options.sandboxApiurl === "string"
      ? options.sandboxApiurl
      : null;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "true") {
    throw new Error("sandbox-api-url must be a non-empty value");
  }
  return trimmed.replace(/\/$/, "");
}

export function resolveBaseUrl(config: LocalConfig): string {
  const envBase = process.env.OPENPOND_BASE_URL;
  const base = envBase || config.baseUrl || DEFAULT_OPENPOND_WEB_BASE_URL;
  return base.replace(/\/$/, "");
}

export function mapUiBaseToApiBase(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  const trimmed = baseUrl.replace(/\/$/, "");
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (
      host === DEFAULT_OPENPOND_WEB_HOST ||
      host === "openpond.live" ||
      host === "www.openpond.live"
    ) {
      return DEFAULT_OPENPOND_API_BASE_URL;
    }
    if (host === DEFAULT_OPENPOND_API_HOST || host.startsWith("api.")) {
      return trimmed;
    }
  } catch {
    return null;
  }
  return null;
}

export function resolvePublicApiBaseUrl(config?: LocalConfig): string {
  const envBase = process.env.OPENPOND_API_URL;
  const configuredApiBase = config?.apiBaseUrl?.trim();
  const mapped = mapUiBaseToApiBase(
    process.env.OPENPOND_BASE_URL || config?.baseUrl
  );
  const base =
    envBase || configuredApiBase || mapped || DEFAULT_OPENPOND_API_BASE_URL;
  return base.replace(/\/$/, "");
}

export function normalizeTemplateRepoUrl(
  input: string,
  baseUrl: string
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("template must be non-empty");
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`;
  }
  const normalizedBase = baseUrl.replace(/\/$/, "");
  const [owner, repoRaw] = trimmed.includes("/")
    ? trimmed.split("/", 2)
    : ["openpondai", trimmed];
  const repo = repoRaw.endsWith(".git") ? repoRaw.slice(0, -4) : repoRaw;
  if (!owner || !repo) {
    throw new Error("template must be <owner>/<repo> or a full https URL");
  }
  return `${normalizedBase}/${owner}/${repo}.git`;
}
