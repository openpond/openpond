import type { Dispatch, SetStateAction } from "react";
import type {
  PatchSessionRequest,
  Session,
  SidebarAppPreference,
  SidebarAppPreferences,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import type { SidebarProjectItem } from "../lib/app-models";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";

export function useSidebarMutations(params: {
  appPreferences: SidebarAppPreferences;
  connection: ClientConnection | null;
  selectedSessionId: string | null;
  setAppPreferences: Dispatch<SetStateAction<SidebarAppPreferences>>;
  setCodexHistorySessions: Dispatch<SetStateAction<Session[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
}) {
  const {
    appPreferences,
    connection,
    selectedSessionId,
    setAppPreferences,
    setCodexHistorySessions,
    setError,
    setSelectedSessionId,
    setSessions,
  } = params;

  async function updateAppPreference(appId: string, patch: SidebarAppPreference) {
    if (!connection) return;
    const previousPreference = appPreferences[appId] ?? {};
    const optimisticPreference = {
      ...previousPreference,
      ...patch,
      archived: patch.pinned ? false : (patch.archived ?? previousPreference.archived),
    };
    setAppPreferences((current) => ({
      ...current,
      [appId]: optimisticPreference,
    }));
    try {
      const updated = await api.patchSidebarAppPreference(connection, appId, patch);
      setAppPreferences((current) => ({
        ...current,
        [appId]: updated,
      }));
    } catch (preferenceError) {
      setError(preferenceError instanceof Error ? preferenceError.message : String(preferenceError));
      setAppPreferences((current) => ({
        ...current,
        [appId]: previousPreference,
      }));
    }
  }

  function toggleProjectPinned(item: SidebarProjectItem) {
    void updateAppPreference(item.id, {
      pinned: !item.pinned,
      archived: false,
    });
  }

  async function patchSessionLocal(session: Session, patch: PatchSessionRequest) {
    if (!connection) return;
    const setTargetSessions = isCodexHistorySessionId(session.id) ? setCodexHistorySessions : setSessions;
    const optimistic: Session = {
      ...session,
      ...patch,
    };
    setTargetSessions((current) =>
      current.some((candidate) => candidate.id === session.id)
        ? current.map((candidate) => (candidate.id === session.id ? optimistic : candidate))
        : [optimistic, ...current]
    );
    try {
      const updated = await api.patchSession(connection, session.id, patch);
      setTargetSessions((current) =>
        current.some((candidate) => candidate.id === updated.id)
          ? current.map((candidate) => (candidate.id === updated.id ? updated : candidate))
          : [updated, ...current]
      );
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : String(patchError));
      setTargetSessions((current) => current.map((candidate) => (candidate.id === session.id ? session : candidate)));
    }
  }

  function toggleSessionPinned(session: Session) {
    void patchSessionLocal(session, {
      pinned: !session.pinned,
      archived: false,
    });
  }

  function archiveSession(session: Session) {
    void patchSessionLocal(session, {
      pinned: false,
      archived: true,
    });
    if (selectedSessionId === session.id) {
      setSelectedSessionId(null);
    }
  }

  function restoreSession(session: Session) {
    void patchSessionLocal(session, {
      archived: false,
    });
  }

  return {
    archiveSession,
    restoreSession,
    toggleProjectPinned,
    toggleSessionPinned,
  };
}
