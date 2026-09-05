import { updateGlobalConfig } from "@openpond/cloud";

import { loadOpenPondAccountContext } from "./account-context.js";
import type { RuntimeLocalAccount } from "./types.js";
import { accountMatchesSelector, normalizeActiveProfile } from "./selectors.js";

export async function signOutOpenPondAccount() {
  let signedOutAccount!: RuntimeLocalAccount;
  await updateGlobalConfig((config) => {
  const activeProfile = normalizeActiveProfile(config.activeProfile);
  const accounts = (config.accounts ?? []).map((account) => ({ ...account }));
  const activeIndex = activeProfile
    ? accounts.findIndex((account) => accountMatchesSelector(account, activeProfile))
    : 0;
  if (activeIndex < 0 || !accounts[activeIndex]) {
    throw new Error("No active OpenPond account to log out.");
  }

  signedOutAccount = { ...accounts[activeIndex] };
  delete signedOutAccount.apiKey;
  delete signedOutAccount.session;
  accounts[activeIndex] = signedOutAccount;

  config.accounts = accounts;
  });
  return loadOpenPondAccountContext(
    signedOutAccount.handle,
    signedOutAccount.baseUrl,
  );
}
