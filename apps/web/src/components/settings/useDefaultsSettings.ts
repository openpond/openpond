import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type {
  AppPreferences,
  BootstrapPayload,
  ChatProvider,
  InsightsEvidenceSourceSettings,
  ProviderSettings,
} from "@openpond/contracts";
import { api, type ClientConnection, type PreferencesPayload } from "../../api";
import { modelRefForTurn, normalizeBranchPrefix, normalizeChatModel } from "../../lib/app-models";

export function useDefaultsSettings({
  connection,
  onError,
  onPayload,
  onPreferences,
  preferences,
  providers,
}: {
  connection: ClientConnection | null;
  onError: (message: string | null) => void;
  onPayload: (payload: BootstrapPayload) => void;
  onPreferences: (payload: PreferencesPayload) => void;
  preferences: AppPreferences;
  providers: ProviderSettings | null | undefined;
}) {
  const [defaultBranchPrefix, setDefaultBranchPrefix] = useState(preferences.defaultBranchPrefix);
  const [defaultNewProjectDirectory, setDefaultNewProjectDirectory] = useState(preferences.defaultNewProjectDirectory);
  const [goalStorageLocation, setGoalStorageLocation] = useState(preferences.goalStorageLocation);
  const [advancedWorkspaceControls, setAdvancedWorkspaceControls] = useState(preferences.advancedWorkspaceControls);
  const [contextCompactionAutoEnabled, setContextCompactionAutoEnabled] = useState(
    preferences.contextCompaction.autoEnabled,
  );
  const [insightsEnabled, setInsightsEnabled] = useState(preferences.insightsEnabled);
  const [insightsUseDefaultModel, setInsightsUseDefaultModel] = useState(!preferences.insightsModelRef);
  const [insightsProvider, setInsightsProvider] = useState<ChatProvider>(
    preferences.insightsModelRef?.providerId ?? preferences.defaultChatProvider,
  );
  const [insightsModel, setInsightsModel] = useState(
    preferences.insightsModelRef?.modelId ?? preferences.defaultChatModel,
  );
  const [insightsEvidenceSources, setInsightsEvidenceSources] = useState(preferences.insightsEvidenceSources);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDefaultBranchPrefix(preferences.defaultBranchPrefix);
    setDefaultNewProjectDirectory(preferences.defaultNewProjectDirectory);
    setGoalStorageLocation(preferences.goalStorageLocation);
    setAdvancedWorkspaceControls(preferences.advancedWorkspaceControls);
    setContextCompactionAutoEnabled(preferences.contextCompaction.autoEnabled);
    setInsightsEnabled(preferences.insightsEnabled);
    setInsightsUseDefaultModel(!preferences.insightsModelRef);
    setInsightsProvider(preferences.insightsModelRef?.providerId ?? preferences.defaultChatProvider);
    setInsightsModel(preferences.insightsModelRef?.modelId ?? preferences.defaultChatModel);
    setInsightsEvidenceSources(preferences.insightsEvidenceSources);
  }, [
    preferences.defaultChatProvider,
    preferences.defaultChatModel,
    preferences.defaultBranchPrefix,
    preferences.defaultNewProjectDirectory,
    preferences.goalStorageLocation,
    preferences.advancedWorkspaceControls,
    preferences.contextCompaction.autoEnabled,
    preferences.insightsEnabled,
    preferences.insightsModelRef,
    preferences.insightsEvidenceSources,
  ]);

  function changeInsightsProvider(provider: ChatProvider) {
    setInsightsProvider(provider);
    setInsightsModel((current) => normalizeChatModel(provider, current, providers));
  }

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
      onPreferences(
        await api.savePreferences(connection, {
          defaultBranchPrefix: normalizeBranchPrefix(defaultBranchPrefix),
          defaultNewProjectDirectory: defaultNewProjectDirectory.trim(),
          goalStorageLocation,
          advancedWorkspaceControls,
          contextCompaction: {
            ...preferences.contextCompaction,
            autoEnabled: contextCompactionAutoEnabled,
          },
          insightsEnabled,
          insightsModelRef: insightsUseDefaultModel
            ? null
            : modelRefForTurn(insightsProvider, insightsModel, providers) ?? null,
          insightsEvidenceSources,
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
    contextCompactionAutoEnabled,
    defaultBranchPrefix,
    defaultNewProjectDirectory,
    goalStorageLocation,
    insightsEnabled,
    insightsUseDefaultModel,
    insightsProvider,
    insightsModel,
    insightsEvidenceSources,
    saving,
    chooseDefaultProjectDirectory,
    saveDefaults,
    changeInsightsProvider,
    setAdvancedWorkspaceControls,
    setContextCompactionAutoEnabled,
    setDefaultBranchPrefix,
    setDefaultNewProjectDirectory,
    setGoalStorageLocation,
    setInsightsEnabled,
    setInsightsUseDefaultModel,
    setInsightsModel,
    setInsightsEvidenceSourceEnabled: (key: keyof InsightsEvidenceSourceSettings, enabled: boolean) =>
      setInsightsEvidenceSources((current) => ({ ...current, [key]: enabled })),
  };
}
