import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { DesktopCorrectionsStateSchema, type BootstrapPayload, type DesktopCorrectionsState } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { isDesktopShell } from "../app-shell/WindowControls";
import { mainPaneAccountScopeKey } from "../app-shell/main-pane-account-scope";

export function desktopCorrectionsRequest<T>(connection: ClientConnection, teamId: string, value: unknown, signal?: AbortSignal) {
  return apiFetch<T>(connection, "/v1/training/evaluation-workspace", {
    method: "POST", body: JSON.stringify({ teamId, projectId: null, operation: "desktopCorrections", value }), signal,
  });
}
type CorrectionsContext = {
  data: DesktopCorrectionsState | null;
  error: unknown;
  loading: boolean;
  webBaseUrl: string | null;
  unavailableReason?: string | null;
  refresh(): Promise<unknown>;
};
export const DesktopCorrectionsContext = createContext<CorrectionsContext | null>(null);
export const useDesktopCorrections = () => useContext(DesktopCorrectionsContext);

/** Mounted in the desktop shell only; the shared web renderer makes no requests. */
export function DesktopCorrectionsProvider({ connection, payload, children }: { connection: ClientConnection | null; payload: BootstrapPayload | null; children: ReactNode }) {
  const teamId = payload?.preferences.defaultTeamId;
  const actorId = payload?.account.profile?.id;
  const desktop = isDesktopShell();
  const enabled = Boolean(desktop && connection && teamId && actorId && payload?.account.state === "signed_in");
  const state = useQuery({ queryKey: ["desktop-corrections", connectionQueryScope(connection), mainPaneAccountScopeKey(payload)],
    enabled, staleTime: 30_000, refetchOnWindowFocus: true,
    queryFn: async ({ signal }) => DesktopCorrectionsStateSchema.parse(await desktopCorrectionsRequest(connection!, teamId!, { actorId: actorId!, action: "read" }, signal)),
  });
  // An account switch must never briefly display a previous user's destination.
  const data = enabled && state.data && state.data.actorId === actorId && state.data.teamId === teamId ? state.data : null;
  const unavailableReason = !connection ? "Connecting to OpenPond"
    : payload?.account.state !== "signed_in" ? "Sign in to log an issue"
    : !actorId ? "Loading your signed-in account"
    : !teamId ? "Select a workspace in Settings to log an issue"
    : state.isPending ? "Loading your issue dataset" : null;
  return <DesktopCorrectionsContext.Provider value={desktop ? { data, error: enabled ? state.error : null,
    loading: enabled && state.isPending, webBaseUrl: payload?.account.activeProfile?.baseUrl ?? payload?.account.baseUrl ?? null,
    unavailableReason, refresh: state.refetch } : null}>
    {children}
  </DesktopCorrectionsContext.Provider>;
}
