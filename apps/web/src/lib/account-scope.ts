import type { AccountState, BootstrapPayload } from "@openpond/contracts";

type AccountInput = BootstrapPayload["account"] | AccountState | null | undefined;

export function openPondAccountScopeKey(account: AccountInput): string | null {
  if (!account || account.state !== "signed_in") return null;

  const activeAccount = account.accounts.find((candidate) => candidate.isActive) ?? null;
  const profileId = account.profile?.id?.trim() ?? "";
  const handle =
    account.activeProfile?.handle?.trim() ||
    activeAccount?.handle?.trim() ||
    account.label.trim() ||
    "signed_in";
  const baseUrl = account.activeProfile?.baseUrl ?? activeAccount?.baseUrl ?? account.baseUrl ?? "";
  const apiBaseUrl = account.apiBaseUrl ?? activeAccount?.apiBaseUrl ?? "";
  const chatApiBaseUrl = account.chatApiBaseUrl ?? activeAccount?.chatApiBaseUrl ?? "";

  return [
    profileId ? `profile:${profileId}` : "profile:unknown",
    handle,
    baseUrl,
    apiBaseUrl,
    chatApiBaseUrl,
  ].join("|");
}
