import { listConfiguredProfiles, loadGlobalConfig, setActiveProfile } from "@openpond/cloud";
import type { ConfiguredProfile } from "@openpond/cloud";
import type { RuntimeAccountContext, RuntimeLocalConfig } from "./types.js";
import { toAccountState } from "./account-state.js";
import { mergeRawApiBaseConfig } from "./config.js";
import { accountToken, fallbackProfilesFromConfig, findActiveAccount, normalizeProfiles } from "./selectors.js";
import { normalizeBaseUrl, resolveHostedChatApiBaseUrl, resolvePublicApiBaseUrl } from "./urls.js";

async function loadProfiles(config: RuntimeLocalConfig): Promise<ConfiguredProfile[]> {
  try {
    return normalizeProfiles(await listConfiguredProfiles());
  } catch {
    return fallbackProfilesFromConfig(config);
  }
}

export async function loadOpenPondAccountContext(
  requestedHandle?: string | null,
  requestedBaseUrl?: string | null
): Promise<RuntimeAccountContext> {
  const config = mergeRawApiBaseConfig((await loadGlobalConfig().catch(() => ({}))) as RuntimeLocalConfig);
  const profiles = await loadProfiles(config);
  const account = findActiveAccount(config, requestedHandle, requestedBaseUrl);
  const token = accountToken(account);
  const apiBaseUrl = resolvePublicApiBaseUrl(account, config);
  const chatApiBaseUrl = resolveHostedChatApiBaseUrl(account, config, apiBaseUrl);
  return {
    config,
    profiles,
    account,
    token,
    apiBaseUrl,
    chatApiBaseUrl,
    accountState: toAccountState({ config, profiles, account, token, apiBaseUrl }),
  };
}

export async function switchOpenPondAccount(input: {
  handle: string;
  baseUrl?: string | null;
}): Promise<RuntimeAccountContext> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  await setActiveProfile(input.handle, {
    baseUrl,
  });
  return loadOpenPondAccountContext(input.handle, baseUrl);
}
