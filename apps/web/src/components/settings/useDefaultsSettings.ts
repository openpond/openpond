import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { AppPreferences, BootstrapPayload } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { normalizeBranchPrefix } from "../../lib/app-models";

export function useDefaultsSettings({
  connection,
  onError,
  onPayload,
  preferences,
}: {
  connection: ClientConnection | null;
  onError: (message: string | null) => void;
  onPayload: (payload: BootstrapPayload) => void;
  preferences: AppPreferences;
}) {
  const [defaultBranchPrefix, setDefaultBranchPrefix] = useState(preferences.defaultBranchPrefix);
  const [defaultNewProjectDirectory, setDefaultNewProjectDirectory] = useState(preferences.defaultNewProjectDirectory);
  const [goalStorageLocation, setGoalStorageLocation] = useState(preferences.goalStorageLocation);
  const [advancedWorkspaceControls, setAdvancedWorkspaceControls] = useState(preferences.advancedWorkspaceControls);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDefaultBranchPrefix(preferences.defaultBranchPrefix);
    setDefaultNewProjectDirectory(preferences.defaultNewProjectDirectory);
    setGoalStorageLocation(preferences.goalStorageLocation);
    setAdvancedWorkspaceControls(preferences.advancedWorkspaceControls);
  }, [
    preferences.defaultBranchPrefix,
    preferences.defaultNewProjectDirectory,
    preferences.goalStorageLocation,
    preferences.advancedWorkspaceControls,
  ]);

  async function chooseDefaultProjectDirectory() {
    let folderPath: string | null = null;
    if (window.openpond?.selectFolder) {
      const result = await window.openpond.selectFolder();
      if (result.canceled) return;
      folderPath = result.path;
    } else {
      folderPath = window.prompt("Default new project directory", defaultNewProjectDirectory);
    }
    if (folderPath?.trim()) setDefaultNewProjectDirectory(folderPath.trim());
  }

  async function saveDefaults(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connection) return;
    setSaving(true);
    onError(null);
    try {
      onPayload(
        await api.savePreferences(connection, {
          defaultBranchPrefix: normalizeBranchPrefix(defaultBranchPrefix),
          defaultNewProjectDirectory: defaultNewProjectDirectory.trim(),
          goalStorageLocation,
          advancedWorkspaceControls,
        })
      );
    } catch (saveError) {
      onError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  return {
    advancedWorkspaceControls,
    defaultBranchPrefix,
    defaultNewProjectDirectory,
    goalStorageLocation,
    saving,
    chooseDefaultProjectDirectory,
    saveDefaults,
    setAdvancedWorkspaceControls,
    setDefaultBranchPrefix,
    setDefaultNewProjectDirectory,
    setGoalStorageLocation,
  };
}
