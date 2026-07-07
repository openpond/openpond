import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type {
  AppPreferences,
  BootstrapPayload,
  ChatProvider,
  InsightsEvidenceSourceSettings,
  ProviderSettings,
  SubagentIsolationMode,
  SubagentPeerMessages,
  SubagentRoleSettings,
  SubagentToolPolicy,
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
  const [subagentsEnabled, setSubagentsEnabled] = useState(preferences.subagents.enabled);
  const [subagentRoles, setSubagentRoles] = useState(preferences.subagents.roles);
  const [subagentsMaxConcurrentRuns, setSubagentsMaxConcurrentRuns] = useState(
    preferences.subagents.maxConcurrentRuns,
  );
  const [subagentsMaxConcurrentRunsPerProvider, setSubagentsMaxConcurrentRunsPerProvider] = useState(
    preferences.subagents.maxConcurrentRunsPerProvider,
  );
  const [subagentsMaxConcurrentRunsPerWorkspaceTarget, setSubagentsMaxConcurrentRunsPerWorkspaceTarget] = useState(
    preferences.subagents.maxConcurrentRunsPerWorkspaceTarget,
  );
  const [subagentsMaxTokens, setSubagentsMaxTokens] = useState<number | null>(preferences.subagents.maxTokens);
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
    setSubagentsEnabled(preferences.subagents.enabled);
    setSubagentRoles(preferences.subagents.roles);
    setSubagentsMaxConcurrentRuns(preferences.subagents.maxConcurrentRuns);
    setSubagentsMaxConcurrentRunsPerProvider(preferences.subagents.maxConcurrentRunsPerProvider);
    setSubagentsMaxConcurrentRunsPerWorkspaceTarget(preferences.subagents.maxConcurrentRunsPerWorkspaceTarget);
    setSubagentsMaxTokens(preferences.subagents.maxTokens);
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
    preferences.subagents,
  ]);

  function changeInsightsProvider(provider: ChatProvider) {
    setInsightsProvider(provider);
    setInsightsModel((current) => normalizeChatModel(provider, current, providers));
  }

  function updateSubagentRole(
    roleId: string,
    updater: (role: SubagentRoleSettings) => SubagentRoleSettings,
  ) {
    setSubagentRoles((current) => current.map((role) => (role.id === roleId ? updater(role) : role)));
  }

  function setSubagentRoleEnabled(roleId: string, enabled: boolean) {
    updateSubagentRole(roleId, (role) => ({ ...role, enabled }));
  }

  function setSubagentRoleBackground(roleId: string, background: boolean) {
    updateSubagentRole(roleId, (role) => ({ ...role, background }));
  }

  function setSubagentRoleUseDefaultModel(roleId: string, useDefault: boolean) {
    updateSubagentRole(roleId, (role) => {
      if (useDefault) return { ...role, modelRef: null };
      const provider = role.modelRef?.providerId ?? preferences.defaultChatProvider;
      const model = role.modelRef?.modelId ?? preferences.defaultChatModel;
      return {
        ...role,
        modelRef: modelRefForTurn(provider, model, providers) ?? null,
      };
    });
  }

  function changeSubagentRoleProvider(roleId: string, provider: ChatProvider) {
    updateSubagentRole(roleId, (role) => ({
      ...role,
      modelRef: modelRefForTurn(provider, role.modelRef?.modelId ?? preferences.defaultChatModel, providers) ?? null,
    }));
  }

  function setSubagentRoleModel(roleId: string, model: string) {
    updateSubagentRole(roleId, (role) => {
      const provider = role.modelRef?.providerId ?? preferences.defaultChatProvider;
      const modelId = model.trim();
      return {
        ...role,
        modelRef: modelId ? { providerId: provider, modelId } : null,
      };
    });
  }

  function setSubagentRoleIsolationMode(roleId: string, isolationMode: SubagentIsolationMode) {
    updateSubagentRole(roleId, (role) => ({ ...role, isolationMode }));
  }

  function setSubagentRoleToolPolicy(roleId: string, toolPolicy: SubagentToolPolicy) {
    updateSubagentRole(roleId, (role) => ({ ...role, toolPolicy }));
  }

  function setSubagentRolePeerMessages(roleId: string, peerMessages: SubagentPeerMessages) {
    updateSubagentRole(roleId, (role) => ({ ...role, peerMessages }));
  }

  function setSubagentRoleMaxConcurrentRuns(roleId: string, value: number) {
    updateSubagentRole(roleId, (role) => ({
      ...role,
      maxConcurrentRuns: clampInteger(value, 1, 16),
    }));
  }

  function setSubagentRoleMaxTurns(roleId: string, value: number | null) {
    updateSubagentRole(roleId, (role) => ({
      ...role,
      maxTurns: value === null ? null : clampInteger(value, 1, 100),
    }));
  }

  function setSubagentRoleMaxTokens(roleId: string, value: number | null) {
    updateSubagentRole(roleId, (role) => ({
      ...role,
      maxTokens: value === null ? null : clampInteger(value, 1, 10_000_000),
    }));
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
          subagents: {
            enabled: subagentsEnabled,
            roles: subagentRoles,
            maxConcurrentRuns: clampInteger(subagentsMaxConcurrentRuns, 1, 32),
            maxConcurrentRunsPerProvider: subagentsMaxConcurrentRunsPerProvider === null
              ? null
              : clampInteger(subagentsMaxConcurrentRunsPerProvider, 1, 32),
            maxConcurrentRunsPerWorkspaceTarget: subagentsMaxConcurrentRunsPerWorkspaceTarget === null
              ? null
              : clampInteger(subagentsMaxConcurrentRunsPerWorkspaceTarget, 1, 32),
            maxTokens: subagentsMaxTokens === null ? null : clampInteger(subagentsMaxTokens, 1, 50_000_000),
          },
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
    subagentsEnabled,
    subagentRoles,
    subagentsMaxConcurrentRuns,
    subagentsMaxConcurrentRunsPerProvider,
    subagentsMaxConcurrentRunsPerWorkspaceTarget,
    subagentsMaxTokens,
    saving,
    chooseDefaultProjectDirectory,
    saveDefaults,
    changeInsightsProvider,
    changeSubagentRoleProvider,
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
    setSubagentsEnabled,
    setSubagentsMaxConcurrentRuns: (value: number) => setSubagentsMaxConcurrentRuns(clampInteger(value, 1, 32)),
    setSubagentsMaxConcurrentRunsPerProvider: (value: number | null) =>
      setSubagentsMaxConcurrentRunsPerProvider(value === null ? null : clampInteger(value, 1, 32)),
    setSubagentsMaxConcurrentRunsPerWorkspaceTarget: (value: number | null) =>
      setSubagentsMaxConcurrentRunsPerWorkspaceTarget(value === null ? null : clampInteger(value, 1, 32)),
    setSubagentsMaxTokens: (value: number | null) => setSubagentsMaxTokens(value),
    setSubagentRoleBackground,
    setSubagentRoleEnabled,
    setSubagentRoleIsolationMode,
    setSubagentRoleMaxConcurrentRuns,
    setSubagentRoleMaxTokens,
    setSubagentRoleMaxTurns,
    setSubagentRoleModel,
    setSubagentRolePeerMessages,
    setSubagentRoleToolPolicy,
    setSubagentRoleUseDefaultModel,
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
