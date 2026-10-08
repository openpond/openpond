import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { BootstrapPayload, RuntimeEvent } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import { createAccountScopeRefresh, type AccountScopeRefresh } from "../lib/account-scope-refresh";

export function useAccountScopeRefresh({ connection, events, refreshRef, setBootstrap, setError }: {
  connection: ClientConnection | null;
  events: readonly RuntimeEvent[];
  refreshRef: MutableRefObject<AccountScopeRefresh | null>;
  setBootstrap: Dispatch<SetStateAction<BootstrapPayload | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  useEffect(() => {
    if (!connection) return;
    const refresh = createAccountScopeRefresh({
      fetch: () => api.accountScopeSnapshot(connection),
      apply: (payload) => setBootstrap((current) => current ? {
        ...current,
        account: payload.account,
        accountMeta: payload.accountMeta,
        preferences: payload.preferences,
        configuration: payload.configuration,
        providers: payload.providers,
        apps: payload.apps,
        appsError: payload.appsError,
        appsMeta: payload.appsMeta,
        cloudProjects: payload.cloudProjects,
      } : current),
      onError: (error) => setError(error instanceof Error ? error.message : String(error)),
    });
    refreshRef.current = refresh;
    const onFocus = () => { void refresh.refresh(); };
    window.addEventListener("focus", onFocus);
    void refresh.refresh();
    return () => {
      refresh.dispose();
      refreshRef.current = null;
      window.removeEventListener("focus", onFocus);
    };
  }, [connection, refreshRef, setBootstrap, setError]);

  let scopeChangeId: string | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.name === "diagnostic" && event.status === "completed" && (
      event.action?.startsWith("openpond.account.") || event.action === "openpond.preferences.update"
    )) {
      scopeChangeId = event.id;
      break;
    }
  }
  useEffect(() => {
    if (scopeChangeId) void refreshRef.current?.refresh();
  }, [connection, refreshRef, scopeChangeId]);
}
