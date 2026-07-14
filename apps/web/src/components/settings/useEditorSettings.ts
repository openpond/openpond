import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type {
  AppPreferences,
  BootstrapPayload,
  WorkspaceEditorPreferences,
  WorkspaceLspLanguageId,
  WorkspaceLspLanguageMode,
  WorkspaceLspSettingsStatusResponse,
} from "@openpond/contracts";
import { api, type ClientConnection, type PreferencesPayload } from "../../api";

export function useEditorSettings({
  connection,
  enabled,
  onError,
  onPreferences,
  onToast,
  preferences,
}: {
  connection: ClientConnection | null;
  enabled: boolean;
  onError: (message: string | null) => void;
  onPayload: (payload: BootstrapPayload) => void;
  onPreferences: (payload: PreferencesPayload) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
  preferences: AppPreferences;
}) {
  const [editorPreferences, setEditorPreferences] = useState<WorkspaceEditorPreferences>(preferences.editor);
  const [lspStatus, setLspStatus] = useState<WorkspaceLspSettingsStatusResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    setEditorPreferences(preferences.editor);
  }, [preferences.editor]);

  const refreshLspStatus = useCallback(async () => {
    if (!connection) return;
    setStatusLoading(true);
    try {
      setLspStatus(await api.workspaceLspSettingsStatus(connection));
    } catch (statusError) {
      onError(statusError instanceof Error ? statusError.message : String(statusError));
    } finally {
      setStatusLoading(false);
    }
  }, [connection, onError]);

  useEffect(() => {
    if (!enabled || !connection) return;
    void refreshLspStatus();
  }, [connection, enabled, refreshLspStatus]);

  function setLanguageMode(language: WorkspaceLspLanguageId, mode: WorkspaceLspLanguageMode) {
    setEditorPreferences((current) => ({
      ...current,
      languages: {
        ...current.languages,
        [language]: {
          ...current.languages[language],
          mode,
        },
      },
    }));
  }

  function setLanguageCustomCommand(language: WorkspaceLspLanguageId, customCommand: string) {
    setEditorPreferences((current) => ({
      ...current,
      languages: {
        ...current.languages,
        [language]: {
          ...current.languages[language],
          customCommand,
        },
      },
    }));
  }

  async function saveEditorSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connection) return;
    setSaving(true);
    onError(null);
    try {
      const payload = await api.savePreferences(connection, {
        editor: editorPreferences,
      });
      onPreferences(payload);
      setLspStatus(await api.workspaceLspSettingsStatus(connection));
    } catch (saveError) {
      onError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function restartLanguageServers() {
    if (!connection) return;
    setRestarting(true);
    onError(null);
    try {
      await api.restartWorkspaceLsp(connection);
      setLspStatus(await api.workspaceLspSettingsStatus(connection));
      onToast?.("Language servers restarted.", "success");
    } catch (restartError) {
      onError(restartError instanceof Error ? restartError.message : String(restartError));
    } finally {
      setRestarting(false);
    }
  }

  return {
    editorPreferences,
    lspStatus,
    restarting,
    saving,
    statusLoading,
    refreshLspStatus,
    restartLanguageServers,
    saveEditorSettings,
    setEditorPreferences,
    setLanguageCustomCommand,
    setLanguageMode,
  };
}
