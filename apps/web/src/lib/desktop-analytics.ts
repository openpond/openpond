import type { AccountState } from "@openpond/contracts";

/** Only stable identity crosses IPC; credentials, account details and content stay local. */
export function reportDesktopAccount(account: AccountState, loginSucceeded = false): void {
  const analytics = window.openpond?.analytics;
  if (!analytics) return;
  void analytics
    .account(
      {
        state: account.state,
        userId: account.profile?.id ?? null,
        baseUrl: account.baseUrl,
      },
      loginSucceeded,
    )
    .catch(() => {
      /* Optional analytics must never interrupt authentication. */
    });
}
