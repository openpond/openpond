import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatProvider, ProviderSettings, Session, WorkspaceKind } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import type { AppAction, AppToast } from "../app/app-state";
import { modelSelectionForSession, normalizeChatModel, projectSelectionKey } from "../lib/app-models";
import { isCloudWorkspaceKind, isHybridWorkspaceSession } from "../lib/workspace-location";

export function shouldForceCloudWorkspaceProviderOpenPond(session: Session | null | undefined): boolean {
  return Boolean(
    session &&
      isCloudWorkspaceKind(session.workspaceKind) &&
      !isHybridWorkspaceSession(session) &&
      session.provider !== "openpond",
  );
}

export function useAppShellEffects({
  activeWorkspaceId,
  activeWorkspaceKind,
  appDispatch,
  connection,
  expandProject,
  linkedProjectByAppId,
  providerSettings,
  selectedAppId,
  selectedSession,
  selectedSessionId,
  selectedSessionProjectId,
  setDiffPanelExpanded,
  setDraftModel,
  setDraftProvider,
  setError,
  setSelectedAppId,
  setSelectedProjectId,
  setSessions,
  setTerminalOpen,
  toast,
}: {
  activeWorkspaceId: string | null;
  activeWorkspaceKind: WorkspaceKind | null;
  appDispatch: Dispatch<AppAction>;
  connection: ClientConnection | null;
  expandProject: (projectId: string) => void;
  linkedProjectByAppId: Map<string, string>;
  providerSettings: ProviderSettings | null;
  selectedAppId: string | null;
  selectedSession: Session | null;
  selectedSessionId: string | null;
  selectedSessionProjectId: string | null;
  setDiffPanelExpanded: Dispatch<SetStateAction<boolean>>;
  setDraftModel: Dispatch<SetStateAction<string>>;
  setDraftProvider: Dispatch<SetStateAction<ChatProvider>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setSelectedAppId: Dispatch<SetStateAction<string | null>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setTerminalOpen: Dispatch<SetStateAction<boolean>>;
  toast: AppToast | null;
}) {
  const lastSyncedSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedAppId) return;
    const linkedProjectId =
      selectedSessionProjectId ??
      (!selectedSessionId ? (linkedProjectByAppId.get(selectedAppId) ?? null) : null);
    if (!linkedProjectId) return;
    const projectKey = projectSelectionKey("local", linkedProjectId);
    setSelectedAppId(null);
    setSelectedProjectId(projectKey);
    expandProject(projectKey);
  }, [
    expandProject,
    linkedProjectByAppId,
    selectedAppId,
    selectedSessionId,
    selectedSessionProjectId,
    setSelectedAppId,
    setSelectedProjectId,
  ]);

  useEffect(() => {
    if (!toast) return undefined;
    if (toast.persistent) return undefined;
    const timeout = window.setTimeout(
      () => {
        appDispatch({ type: "clearToast", toastId: toast.id });
      },
      toast.tone === "error" ? 7000 : 3500,
    );
    return () => window.clearTimeout(timeout);
  }, [appDispatch, toast]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "`") {
        event.preventDefault();
        setTerminalOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setTerminalOpen]);

  useEffect(() => {
    setDiffPanelExpanded(false);
  }, [activeWorkspaceId, activeWorkspaceKind, setDiffPanelExpanded]);

  useEffect(() => {
    if (!selectedSessionId) {
      lastSyncedSessionIdRef.current = null;
      return;
    }
    if (!selectedSession || selectedSession.id !== selectedSessionId) return;
    if (lastSyncedSessionIdRef.current === selectedSession.id) return;

    lastSyncedSessionIdRef.current = selectedSession.id;
    const selection = modelSelectionForSession(selectedSession, providerSettings);
    setDraftProvider(selection.provider);
    setDraftModel(selection.model);
  }, [
    providerSettings,
    selectedSession,
    selectedSessionId,
    setDraftModel,
    setDraftProvider,
  ]);

  useEffect(() => {
    if (!connection || !selectedSession || !shouldForceCloudWorkspaceProviderOpenPond(selectedSession)) return;
    void api
      .patchSession(connection, selectedSession.id, { provider: "openpond" })
      .then((updated) => {
        setSessions((current) =>
          current.map((session) => (session.id === updated.id ? updated : session)),
        );
        setDraftProvider("openpond");
        setDraftModel((current) => normalizeChatModel("openpond", current));
      })
      .catch((providerError) => {
        setError(providerError instanceof Error ? providerError.message : String(providerError));
      });
  }, [connection, selectedSession, setDraftModel, setDraftProvider, setError, setSessions]);
}
