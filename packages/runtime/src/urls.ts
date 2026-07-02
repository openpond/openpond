import {
  DEFAULT_OPENPOND_API_BASE_URL,
  DEFAULT_OPENPOND_WEB_BASE_URL,
} from "@openpond/cloud";
import type { RuntimeLocalAccount, RuntimeLocalConfig } from "./types.js";

const DEFAULT_OPENPOND_API_HOST = new URL(DEFAULT_OPENPOND_API_BASE_URL).hostname;
const DEFAULT_OPENPOND_WEB_HOST = new URL(DEFAULT_OPENPOND_WEB_BASE_URL).hostname;
export const DEFAULT_OPENPOND_OPCHAT_API_BASE_URL = `${DEFAULT_OPENPOND_API_BASE_URL}/opchat/v1`;

export {
  DEFAULT_OPENPOND_API_BASE_URL,
  DEFAULT_OPENPOND_WEB_BASE_URL,
};

export function normalizeBaseUrl(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

export function mapUiBaseToApiBase(baseUrl?: string | null): string | null {
  const trimmed = normalizeBaseUrl(baseUrl);
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (host === DEFAULT_OPENPOND_API_HOST) return DEFAULT_OPENPOND_API_BASE_URL;
    if (host === DEFAULT_OPENPOND_WEB_HOST || host === "openpond.live" || host === "www.openpond.live") {
      return DEFAULT_OPENPOND_API_BASE_URL;
    }
    if (host.startsWith("api.")) return trimmed;
  } catch {
    return null;
  }
  return null;
}

export function resolvePublicApiBaseUrl(account: RuntimeLocalAccount | null, config: RuntimeLocalConfig): string {
  const envBase = normalizeBaseUrl(process.env.OPENPOND_API_URL);
  if (envBase) return envBase;
  const accountApiBase = normalizeBaseUrl(account?.apiBaseUrl);
  if (accountApiBase) return accountApiBase;
  const configApiBase = normalizeBaseUrl(config.apiBaseUrl);
  if (configApiBase) return configApiBase;
  const mappedEnvBase = mapUiBaseToApiBase(process.env.OPENPOND_BASE_URL);
  if (mappedEnvBase) return mappedEnvBase;
  const mappedConfigBase = mapUiBaseToApiBase(account?.baseUrl || config.baseUrl);
  return mappedConfigBase ?? DEFAULT_OPENPOND_API_BASE_URL;
}

export function resolveHostedChatApiBaseUrl(
  account: RuntimeLocalAccount | null,
  config: RuntimeLocalConfig,
  publicApiBaseUrl: string
): string {
  return resolveOpChatApiBaseUrl(account, config, publicApiBaseUrl);
}

function resolveOpChatApiBaseUrl(
  account: RuntimeLocalAccount | null,
  config: RuntimeLocalConfig,
  publicApiBaseUrl: string
): string {
  const runtimeEnv = typeof process !== "undefined" ? process.env : {};
  return (
    normalizeOpChatApiBaseUrl(runtimeEnv.OPENPOND_OPCHAT_API_URL) ??
    normalizeOpChatApiBaseUrl(account?.chatApiBaseUrl ?? config.chatApiBaseUrl) ??
    normalizeOpChatApiBaseUrl(runtimeEnv.OPENPOND_CHAT_API_URL) ??
    opChatBaseFromPublicApiBase(publicApiBaseUrl)
  );
}

function normalizeOpChatApiBaseUrl(value?: string | null): string | null {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const opChatIndex = segments.findIndex((segment) => segment.toLowerCase() === "opchat");
    if (opChatIndex >= 0) {
      url.pathname = `/${[...segments.slice(0, opChatIndex + 1), "v1"].join("/")}`;
      url.search = "";
      url.hash = "";
      return normalizeBaseUrl(url.toString()) ?? null;
    }
    const v1Index = segments.findIndex((segment) => segment.toLowerCase() === "v1");
    if (v1Index >= 0) {
      url.pathname = "/opchat/v1";
      url.search = "";
      url.hash = "";
      return normalizeBaseUrl(url.toString()) ?? null;
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/opchat/v1`.replace(/\/{2,}/g, "/");
    url.search = "";
    url.hash = "";
    return normalizeBaseUrl(url.toString()) ?? null;
  } catch {
    return null;
  }
}

function opChatBaseFromPublicApiBase(publicApiBaseUrl: string): string {
  return normalizeOpChatApiBaseUrl(publicApiBaseUrl) ?? DEFAULT_OPENPOND_OPCHAT_API_BASE_URL;
}

export function deriveEnvironment(baseUrl?: string | null, fallback?: string | null): string {
  if (fallback?.trim()) return fallback.trim();
  return "production";
}
