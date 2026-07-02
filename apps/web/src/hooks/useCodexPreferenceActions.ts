import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  BootstrapPayload,
  CodexPermissionMode,
  CodexReasoningEffort,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import {
  writeStoredCodexPermissionMode,
  writeStoredCodexReasoningEffort,
} from "../lib/codex-preferences";

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
      setCodexPermissionMode(mode);
      writeStoredCodexPermissionMode(mode);
      if (!connection) return;
      void api
        .savePreferences(connection, { codexPermissionMode: mode })
        .then(() => {
          setBootstrap((current) =>
            current
              ? {
                  ...current,
                  preferences: {
                    ...current.preferences,
                    codexPermissionMode: mode,
                  },
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
    [connection, setBootstrap, setCodexPermissionMode, setError],
  );

  const changeCodexReasoningEffort = useCallback(
    (effort: CodexReasoningEffort) => {
      setCodexReasoningEffort(effort);
      writeStoredCodexReasoningEffort(effort);
      if (!connection) return;
      void api
        .savePreferences(connection, { codexReasoningEffort: effort })
        .then(() => {
          setBootstrap((current) =>
            current
              ? {
                  ...current,
                  preferences: {
                    ...current.preferences,
                    codexReasoningEffort: effort,
                  },
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
    [connection, setBootstrap, setCodexReasoningEffort, setError],
  );

  return {
    changeCodexPermissionMode,
    changeCodexReasoningEffort,
  };
}
