import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeLocalConfig } from "./types.js";
import { baseUrlEquals, handleEquals } from "./selectors.js";

function readRawOpenPondConfig(): RuntimeLocalConfig {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".openpond", "config.json"), "utf8")) as RuntimeLocalConfig;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function mergeRawApiBaseConfig(config: RuntimeLocalConfig): RuntimeLocalConfig {
  const raw = readRawOpenPondConfig();
  const rawAccounts = Array.isArray(raw.accounts) ? raw.accounts : [];
  const accounts = Array.isArray(config.accounts) ? config.accounts : [];
  return {
    ...config,
    activeProfile: config.activeProfile ?? raw.activeProfile,
    apiBaseUrl: config.apiBaseUrl ?? raw.apiBaseUrl,
    chatApiBaseUrl: config.chatApiBaseUrl ?? raw.chatApiBaseUrl,
    accounts: accounts.map((account) => {
      const rawAccount =
        rawAccounts.find(
          (candidate) => handleEquals(candidate.handle, account.handle) && baseUrlEquals(candidate.baseUrl, account.baseUrl)
        ) ?? rawAccounts.find((candidate) => handleEquals(candidate.handle, account.handle));
      return {
        ...account,
        ...(typeof rawAccount?.apiBaseUrl === "string" && rawAccount.apiBaseUrl.trim()
          ? { apiBaseUrl: rawAccount.apiBaseUrl }
          : {}),
        ...(typeof rawAccount?.chatApiBaseUrl === "string" && rawAccount.chatApiBaseUrl.trim()
          ? { chatApiBaseUrl: rawAccount.chatApiBaseUrl }
          : {}),
      };
    }),
  };
}
