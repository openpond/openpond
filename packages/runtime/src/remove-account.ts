import { updateGlobalConfig } from "@openpond/cloud";
import type { RuntimeLocalAccount } from "./types.js";
import { loadOpenPondAccountContext } from "./account-context.js";
import {
  accountMatchesSelector,
  baseUrlEquals,
  handleEquals,
  normalizeActiveProfile,
} from "./selectors.js";
import { normalizeBaseUrl } from "./urls.js";

function findAccountIndex(
  accounts: RuntimeLocalAccount[],
  handle: string,
  baseUrl?: string | null
): number {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const exactIndex = accounts.findIndex(
    (account) =>
      handleEquals(account.handle, handle) &&
      baseUrlEquals(account.baseUrl, normalizedBaseUrl)
  );
  if (exactIndex !== -1) return exactIndex;

  const matchingIndexes = accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => handleEquals(account.handle, handle));
  if (matchingIndexes.length === 1) return matchingIndexes[0]!.index;
  if (matchingIndexes.length > 1) {
    throw new Error(
      `Multiple OpenPond accounts match ${handle}; select one with its base URL.`
    );
  }
  return -1;
}

export async function removeOpenPondAccount(input: {
  handle: string;
  baseUrl?: string | null;
}) {
  const handle = input.handle.trim();
  if (!handle) throw new Error("OpenPond account handle is required.");

  await updateGlobalConfig((config) => {
  const accounts = (config.accounts ?? []).map((account) => ({ ...account }));
  const index = findAccountIndex(accounts, handle, input.baseUrl);
  if (index === -1) throw new Error(`OpenPond account not found: ${handle}`);

  const account = accounts[index]!;
  const activeProfile = normalizeActiveProfile(config.activeProfile);
  if (activeProfile && accountMatchesSelector(account, activeProfile)) {
    throw new Error(
      "Switch to another OpenPond account before removing the active account."
    );
  }

  accounts.splice(index, 1);
  config.accounts = accounts;
  });
  return loadOpenPondAccountContext();
}
