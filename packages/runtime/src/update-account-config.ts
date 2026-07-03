import { loadGlobalConfig, saveConfig } from "@openpond/cloud";
import type { LocalConfig } from "@openpond/cloud";
import type { RuntimeAccountContext, RuntimeLocalAccount, UpdateOpenPondAccountConfigInput } from "./types.js";
import { loadOpenPondAccountContext } from "./account-context.js";
import {
  accountMatchesSelector,
  baseUrlEquals,
  handleEquals,
  normalizeActiveProfile,
  selectorFromAccount,
} from "./selectors.js";
import { normalizeBaseUrl } from "./urls.js";

function findAccountIndex(
  accounts: RuntimeLocalAccount[],
  handle: string,
  currentBaseUrl?: string | null
): number {
  const normalizedCurrentBaseUrl = normalizeBaseUrl(currentBaseUrl);
  const exactIndex = accounts.findIndex(
    (account) => handleEquals(account.handle, handle) && baseUrlEquals(account.baseUrl, normalizedCurrentBaseUrl)
  );
  if (exactIndex !== -1) return exactIndex;

  const sameHandle = accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => handleEquals(account.handle, handle));
  if (sameHandle.length === 1) return sameHandle[0]!.index;
  if (sameHandle.length > 1) {
    throw new Error(`Multiple OpenPond accounts match ${handle}; select one with its current base URL.`);
  }
  return -1;
}

function applyOptionalUrl(
  account: RuntimeLocalAccount,
  key: "baseUrl" | "apiBaseUrl" | "chatApiBaseUrl",
  value?: string | null
): void {
  if (value === undefined) return;
  const normalized = normalizeBaseUrl(value);
  if (normalized) {
    account[key] = normalized;
    return;
  }
  if (value === null || value.trim() === "") delete account[key];
}

export async function updateOpenPondAccountConfig(
  input: UpdateOpenPondAccountConfigInput
): Promise<RuntimeAccountContext> {
  const handle = input.handle.trim();
  if (!handle) throw new Error("OpenPond account handle is required.");

  const config = (await loadGlobalConfig()) as LocalConfig & {
    accounts?: RuntimeLocalAccount[];
  };
  const accounts = (config.accounts ?? []).map((account) => ({ ...account }));
  const index = findAccountIndex(accounts, handle, input.currentBaseUrl);
  if (index === -1) throw new Error(`OpenPond account not found: ${handle}`);

  const previousAccount = accounts[index]!;
  const nextAccount: RuntimeLocalAccount = { ...previousAccount };
  applyOptionalUrl(nextAccount, "baseUrl", input.baseUrl);
  applyOptionalUrl(nextAccount, "apiBaseUrl", input.apiBaseUrl);
  applyOptionalUrl(nextAccount, "chatApiBaseUrl", input.chatApiBaseUrl);
  if (input.environment === null) {
    delete nextAccount.environment;
  } else if (typeof input.environment === "string" && input.environment.trim()) {
    nextAccount.environment = input.environment.trim();
  }

  const duplicateIndex = accounts.findIndex(
    (account, candidateIndex) =>
      candidateIndex !== index &&
      handleEquals(account.handle, nextAccount.handle) &&
      baseUrlEquals(account.baseUrl, nextAccount.baseUrl)
  );
  if (duplicateIndex !== -1) {
    throw new Error("Another OpenPond account already uses that handle and base URL.");
  }

  const activeProfile = normalizeActiveProfile(config.activeProfile);
  const wasActive = Boolean(activeProfile && accountMatchesSelector(previousAccount, activeProfile));
  accounts[index] = nextAccount;

  await saveConfig({
    ...config,
    accounts,
    activeProfile: input.setActive || wasActive ? selectorFromAccount(nextAccount) : config.activeProfile,
  });

  return loadOpenPondAccountContext(nextAccount.handle, nextAccount.baseUrl);
}
