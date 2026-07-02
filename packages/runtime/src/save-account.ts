import { createHash } from "node:crypto";
import { getOpenPondAccount, listApps, saveProfileApiKey } from "@openpond/cloud";
import type { RuntimeAccountContext, SaveOpenPondAccountInput } from "./types.js";
import { loadOpenPondAccountContext } from "./account-context.js";
import {
  DEFAULT_OPENPOND_API_BASE_URL,
  DEFAULT_OPENPOND_WEB_BASE_URL,
  mapUiBaseToApiBase,
  normalizeBaseUrl,
} from "./urls.js";

function fallbackHandleForApiKey(apiKey: string): string {
  const digest = createHash("sha256").update(apiKey).digest("hex").slice(0, 8);
  return `account-${digest}`;
}

function normalizeDerivedHandle(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^@/, "");
}

async function deriveHandleForApiKey(input: SaveOpenPondAccountInput, apiBaseUrl: string): Promise<string> {
  const explicit = normalizeDerivedHandle(input.handle);
  if (explicit) return explicit;

  try {
    const response = await getOpenPondAccount(apiBaseUrl, input.apiKey);
    const account = response.account;
    const fromProfile =
      normalizeDerivedHandle(account.handle) ??
      normalizeDerivedHandle(account.email?.split("@")[0]) ??
      normalizeDerivedHandle(account.id);
    if (fromProfile) return fromProfile;
  } catch {
    // Fall back to app ownership when /account is temporarily unavailable.
  }

  try {
    const apps = await listApps(apiBaseUrl, input.apiKey);
    const counts = new Map<string, number>();
    for (const app of apps) {
      const handle = normalizeDerivedHandle(app.handle);
      if (!handle) continue;
      counts.set(handle, (counts.get(handle) ?? 0) + 1);
    }
    const [handle] = Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0] ?? [];
    if (handle) return handle;
  } catch {
    // Use a deterministic non-secret label if neither profile nor apps can identify the account.
  }

  return fallbackHandleForApiKey(input.apiKey);
}

export async function saveOpenPondAccount(input: SaveOpenPondAccountInput): Promise<RuntimeAccountContext> {
  const baseUrl = input.baseUrl ?? DEFAULT_OPENPOND_WEB_BASE_URL;
  const apiBaseUrl = normalizeBaseUrl(input.apiBaseUrl) ?? mapUiBaseToApiBase(baseUrl) ?? DEFAULT_OPENPOND_API_BASE_URL;
  const chatApiBaseUrl = normalizeBaseUrl(input.chatApiBaseUrl);
  const handle = await deriveHandleForApiKey(input, apiBaseUrl);
  await saveProfileApiKey({
    handle,
    apiKey: input.apiKey,
    baseUrl,
    apiBaseUrl,
    chatApiBaseUrl,
    environment: input.environment ?? "production",
    setActive: input.setActive,
  });
  return loadOpenPondAccountContext(handle, baseUrl);
}
