import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  BootstrapPayload,
  OpenPondCommandAccessMode,
  Session,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import { writeStoredOpenPondCommandAccessMode } from "../lib/openpond-command-access-preferences";

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
      setOpenPondCommandAccessMode(mode);
      writeStoredOpenPondCommandAccessMode(mode);

      const sessionToPatch = session?.provider === "codex" ? null : session;
      if (sessionToPatch) {
        setSessions((current) =>
          current.map((candidate) =>
            candidate.id === sessionToPatch.id
              ? { ...candidate, openPondCommandAccessMode: mode }
              : candidate,
          ),
        );
      }

      if (!connection) return;

      void api
        .savePreferences(connection, { openPondCommandAccessMode: mode })
        .then(() => {
          setBootstrap((current) =>
            current
              ? {
                  ...current,
                  preferences: {
                    ...current.preferences,
                    openPondCommandAccessMode: mode,
                  },
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
