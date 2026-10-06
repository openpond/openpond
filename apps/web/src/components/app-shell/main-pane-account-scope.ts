import type { MainPaneProps } from "./main-pane-types";

/** Remount account-owned panels when local login ownership or workspace changes. */
export function mainPaneAccountScopeKey(bootstrap: MainPaneProps["bootstrap"]) {
  return JSON.stringify({
    account: bootstrap?.account.activeProfile ?? null,
    baseUrl: bootstrap?.account.baseUrl ?? null,
    owner: bootstrap?.account.profile?.id ?? null,
    state: bootstrap?.account.state ?? null,
    teamId: bootstrap?.preferences.defaultTeamId ?? null,
  });
}
