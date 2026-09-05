import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  BootstrapPayload,
  CodexPermissionMode,
  CodexReasoningEffort,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";


export function useCodexPreferenceActions({
  connection,
  setBootstrap,
  setCodexPermissionMode,
  setCodexReasoningEffort,
  setError,
}: {
  connection: ClientConnection | null;
  setBootstrap: Dispatch<SetStateAction<BootstrapPayload | null>>;
  setCodexPermissionMode: Dispatch<SetStateAction<CodexPermissionMode>>;
  setCodexReasoningEffort: Dispatch<SetStateAction<CodexReasoningEffort>>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const changeCodexPermissionMode = useCallback(
    (mode: CodexPermissionMode) => {
      if (!connection) { setError("Connect to OpenPond before saving preferences."); return; }
      void api
        .savePreferences(connection, { codexPermissionMode: mode })
        .then((payload) => {
          setCodexPermissionMode(payload.preferences.codexPermissionMode);
          setCodexReasoningEffort(payload.preferences.codexReasoningEffort);
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
          setError(
            preferenceError instanceof Error ? preferenceError.message : String(preferenceError),
          );
        });
    },
    [connection, setBootstrap, setCodexPermissionMode, setCodexReasoningEffort, setError],
  );

  const changeCodexReasoningEffort = useCallback(
    (effort: CodexReasoningEffort) => {
      if (!connection) { setError("Connect to OpenPond before saving preferences."); return; }
      void api
        .savePreferences(connection, { codexReasoningEffort: effort })
        .then((payload) => {
          setCodexPermissionMode(payload.preferences.codexPermissionMode);
          setCodexReasoningEffort(payload.preferences.codexReasoningEffort);
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
          setError(
            preferenceError instanceof Error ? preferenceError.message : String(preferenceError),
          );
        });
    },
    [connection, setBootstrap, setCodexPermissionMode, setCodexReasoningEffort, setError],
  );

  return {
    changeCodexPermissionMode,
    changeCodexReasoningEffort,
  };
}
