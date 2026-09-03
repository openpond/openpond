import { loadGlobalConfig, saveConfig } from "@openpond/cloud";
import type { LocalConfig } from "@openpond/cloud";

import { loadOpenPondAccountContext } from "./account-context.js";
import type { RuntimeLocalAccount } from "./types.js";
import { accountMatchesSelector, normalizeActiveProfile } from "./selectors.js";

export async function signOutOpenPondAccount() {
  const config = (await loadGlobalConfig()) as LocalConfig & {
    accounts?: RuntimeLocalAccount[];
  };
  const activeProfile = normalizeActiveProfile(config.activeProfile);
  const accounts = (config.accounts ?? []).map((account) => ({ ...account }));
  const activeIndex = activeProfile
    ? accounts.findIndex((account) => accountMatchesSelector(account, activeProfile))
    : 0;
  if (activeIndex < 0 || !accounts[activeIndex]) {
    throw new Error("No active OpenPond account to log out.");
  }

  const signedOutAccount = { ...accounts[activeIndex] };
  delete signedOutAccount.apiKey;
  delete signedOutAccount.session;
  accounts[activeIndex] = signedOutAccount;

  await saveConfig({ ...config, accounts });
  return loadOpenPondAccountContext(
    signedOutAccount.handle,
    signedOutAccount.baseUrl,
  );
}
