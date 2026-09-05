import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  BootstrapPayload,
  OpenPondCommandAccessMode,
  Session,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

export function useOpenPondCommandAccessActions({
  connection,
  selectedSession,
  setBootstrap,
  setError,
  setOpenPondCommandAccessMode,
  setSessions,
}: {
  connection: ClientConnection | null;
  selectedSession: Session | null;
  setBootstrap: Dispatch<SetStateAction<BootstrapPayload | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setOpenPondCommandAccessMode: Dispatch<SetStateAction<OpenPondCommandAccessMode>>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
}) {
  const changeOpenPondCommandAccessMode = useCallback(
    (mode: OpenPondCommandAccessMode, session: Session | null = selectedSession) => {
      if (!connection) { setError("Connect to OpenPond before saving preferences."); return; }
      const sessionToPatch = session?.provider === "codex" ? null : session;

      void api
        .savePreferences(connection, { openPondCommandAccessMode: mode })
        .then((payload) => {
          setOpenPondCommandAccessMode(payload.preferences.openPondCommandAccessMode);
          setBootstrap((current) =>
            current
              ? {
                  ...current,
                  preferences: payload.preferences,
                }
              : current,
          );
        })
        .catch((preferenceError) => {
          setError(preferenceError instanceof Error ? preferenceError.message : String(preferenceError));
        });

      if (!sessionToPatch) return;

      void api
        .patchSession(connection, sessionToPatch.id, { openPondCommandAccessMode: mode })
        .then((updatedSession) => {
          setSessions((current) =>
            current.map((candidate) =>
              candidate.id === updatedSession.id ? updatedSession : candidate,
            ),
          );
        })
        .catch((sessionError) => {
          setError(sessionError instanceof Error ? sessionError.message : String(sessionError));
        });
    },
    [
      connection,
      selectedSession,
      setBootstrap,
      setError,
      setOpenPondCommandAccessMode,
      setSessions,
    ],
  );

  return {
    changeOpenPondCommandAccessMode,
  };
}
