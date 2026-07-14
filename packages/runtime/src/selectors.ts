import type { ActiveProfileSelector, ConfiguredProfile } from "@openpond/cloud";
import type { RuntimeLocalAccount, RuntimeLocalConfig } from "./types.js";
import { deriveEnvironment, normalizeBaseUrl } from "./urls.js";

export function accountToken(account: RuntimeLocalAccount | null): string | null {
  const candidates = [
    account?.apiKey,
    account?.session?.token,
    account?.token,
  ];
  for (const value of candidates) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) return trimmed;
  }
  return null;
}

export function handleEquals(left?: string | null, right?: string | null): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

export function baseUrlEquals(left?: string | null, right?: string | null): boolean {
  return normalizeBaseUrl(left) === normalizeBaseUrl(right);
}

export function profileKey(handle?: string | null, baseUrl?: string | null): string {
  const normalizedHandle = handle?.trim().toLowerCase() || "";
  return `${normalizedHandle}|${normalizeBaseUrl(baseUrl) ?? "default"}`;
}

export function selectorBaseUrl(selector?: ActiveProfileSelector | null): string | null {
  return normalizeBaseUrl(selector?.baseUrl);
}

export function selectorFromAccount(account: RuntimeLocalAccount): ActiveProfileSelector {
  const baseUrl = normalizeBaseUrl(account.baseUrl);
  return baseUrl ? { handle: account.handle, baseUrl } : { handle: account.handle };
}

export function normalizeActiveProfile(value?: ActiveProfileSelector | null): ActiveProfileSelector | null {
  const handle = typeof value?.handle === "string" ? value.handle.trim() : "";
  if (!handle) return null;
  const baseUrl = normalizeBaseUrl(value?.baseUrl);
  return baseUrl ? { handle, baseUrl } : { handle };
}

export function accountMatchesSelector(account: RuntimeLocalAccount, selector: ActiveProfileSelector): boolean {
  if (!handleEquals(account.handle, selector.handle)) return false;
  const baseUrl = selectorBaseUrl(selector);
  if (baseUrl) return baseUrlEquals(account.baseUrl, baseUrl);
  return !normalizeBaseUrl(account.baseUrl);
}

export function profileMatchesSelector(profile: ConfiguredProfile, selector: ActiveProfileSelector): boolean {
  if (!handleEquals(profile.handle, selector.handle)) return false;
  const baseUrl = selectorBaseUrl(selector);
  if (baseUrl) return baseUrlEquals(profile.baseUrl, baseUrl);
  return !normalizeBaseUrl(profile.baseUrl);
}

export function findActiveAccount(
  config: RuntimeLocalConfig,
  requestedHandle?: string | null,
  requestedBaseUrl?: string | null
): RuntimeLocalAccount | null {
  const accounts = Array.isArray(config.accounts) ? (config.accounts as RuntimeLocalAccount[]) : [];
  const requestedProfile =
    requestedHandle || process.env.OPENPOND_ACCOUNT
      ? normalizeActiveProfile({
          handle: requestedHandle || process.env.OPENPOND_ACCOUNT || "",
          baseUrl: requestedBaseUrl ?? process.env.OPENPOND_BASE_URL ?? null,
        })
      : normalizeActiveProfile(config.activeProfile);

  if (requestedProfile) {
    const exact = accounts.find((account) => accountMatchesSelector(account, requestedProfile));
    if (exact) return exact;

    const sameHandle = accounts.filter((account) => handleEquals(account.handle, requestedProfile.handle));
    if (!selectorBaseUrl(requestedProfile) && sameHandle.length === 1) return sameHandle[0] ?? null;
  }

  if (accounts[0]) return accounts[0];
  return null;
}

export function fallbackProfilesFromConfig(config: RuntimeLocalConfig): ConfiguredProfile[] {
  const accounts = Array.isArray(config.accounts) ? (config.accounts as RuntimeLocalAccount[]) : [];
  const activeProfile = normalizeActiveProfile(config.activeProfile) ?? (accounts[0] ? selectorFromAccount(accounts[0]) : null);
  return normalizeProfiles(
    accounts.map((account) => ({
      handle: account.handle,
      baseUrl: normalizeBaseUrl(account.baseUrl),
      apiBaseUrl: normalizeBaseUrl(account.apiBaseUrl),
      chatApiBaseUrl: normalizeBaseUrl(account.chatApiBaseUrl),
      environment: deriveEnvironment(account.environment),
      isActive: activeProfile ? accountMatchesSelector(account, activeProfile) : false,
      hasApiKey: Boolean(account.apiKey?.trim()),
      hasSessionToken: Boolean(account.session?.token?.trim() || account.token?.trim()),
      sessionAppId: account.session?.appId ?? null,
      sessionConversationId: account.session?.conversationId ?? null,
    }))
  );
}

export function normalizeProfiles(profiles: ConfiguredProfile[]): ConfiguredProfile[] {
  const result = new Map<string, ConfiguredProfile>();
  for (const profile of profiles) {
    const normalizedBaseUrl = normalizeBaseUrl(profile.baseUrl);
    const key = `${profile.handle.toLowerCase()}|${normalizedBaseUrl ?? "default"}`;
    const normalized: ConfiguredProfile = {
      ...profile,
      baseUrl: normalizedBaseUrl,
      apiBaseUrl: normalizeBaseUrl(profile.apiBaseUrl),
      chatApiBaseUrl: normalizeBaseUrl(profile.chatApiBaseUrl),
      environment: deriveEnvironment(profile.environment),
      isActive: profile.isActive,
    };
    const current = result.get(key);
    if (!current || (normalized.isActive && !current.isActive) || (normalized.hasApiKey && !current.hasApiKey)) {
      result.set(key, normalized);
    }
  }
  return Array.from(result.values());
}

export function profileAuthHealth(profile: ConfiguredProfile): "signed_out" | "signed_in" | "auth_error" {
  return profile.hasApiKey || profile.hasSessionToken ? "signed_in" : "signed_out";
}
