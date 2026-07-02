import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Session } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import type { AppAction, RightPanelMode } from "../app/app-state";
import type { AppView } from "../lib/app-models";

export function useOpenSandboxWorkspace({
  appDispatch,
  connection,
  sessions,
  setDiffPanelOpen,
  setRightPanelMode,
  setSessions,
  setView,
}: {
  appDispatch: Dispatch<AppAction>;
  connection: ClientConnection | null;
  sessions: Session[];
  setDiffPanelOpen: Dispatch<SetStateAction<boolean>>;
  setRightPanelMode: Dispatch<SetStateAction<RightPanelMode>>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setView: Dispatch<SetStateAction<AppView>>;
}) {
  return useCallback(
    async (input: { sandboxId: string; name: string | null }) => {
      if (!connection) return;
      const existingSession = sessions.find(
        (session) =>
          !session.archived &&
          session.workspaceKind === "sandbox" &&
          session.workspaceId === input.sandboxId,
      );
      if (existingSession) {
        appDispatch({
          type: "selectSession",
          sessionId: existingSession.id,
          appId: null,
          projectId: null,
        });
        setRightPanelMode("changes");
        setDiffPanelOpen(true);
        setView("chat");
        return;
      }
      const workspaceName = input.name ?? `Sandbox ${input.sandboxId.slice(0, 8)}`;
      const session = await api.createSession(connection, {
        provider: "openpond",
        appId: null,
        appName: null,
        workspaceKind: "sandbox",
        workspaceId: input.sandboxId,
        workspaceName,
        cwd: null,
        title: workspaceName,
      });
      setSessions((current) => [session, ...current]);
      appDispatch({
        type: "selectSession",
        sessionId: session.id,
        appId: null,
        projectId: null,
      });
      setRightPanelMode("changes");
      setDiffPanelOpen(true);
      setView("chat");
    },
    [appDispatch, connection, sessions, setDiffPanelOpen, setRightPanelMode, setSessions, setView],
  );
}
