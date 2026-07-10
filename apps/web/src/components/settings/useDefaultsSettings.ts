import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type {
  AppPreferences,
  BootstrapPayload,
  ChatProvider,
  InsightsEvidenceSourceSettings,
  ProviderSettings,
  SubagentIsolationMode,
  SubagentDelegationMode,
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
  const [subagentDelegationMode, setSubagentDelegationMode] = useState(
    preferences.subagents.delegationMode,
  );
  const [subagentsUseDefaultModel, setSubagentsUseDefaultModel] = useState(!preferences.subagents.defaultModelRef);
  const [subagentsProvider, setSubagentsProvider] = useState<ChatProvider>(
    preferences.subagents.defaultModelRef?.providerId ?? preferences.defaultChatProvider,
  );
  const [subagentsModel, setSubagentsModel] = useState(
    preferences.subagents.defaultModelRef?.modelId ?? preferences.defaultChatModel,
  );
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
  const [subagentsHeartbeatIntervalSeconds, setSubagentsHeartbeatIntervalSeconds] = useState(
    preferences.subagents.heartbeatIntervalSeconds,
  );
  const [saving, setSaving] = useState(false);
  const subagentsDefaultModelRef = subagentsUseDefaultModel
    ? null
    : { providerId: subagentsProvider, modelId: subagentsModel.trim() };
  const subagentsDirty =
    subagentsEnabled !== preferences.subagents.enabled ||
    subagentDelegationMode !== preferences.subagents.delegationMode ||
    !chatModelRefsEqual(subagentsDefaultModelRef, preferences.subagents.defaultModelRef) ||
    subagentsMaxConcurrentRuns !== preferences.subagents.maxConcurrentRuns ||
    subagentsMaxConcurrentRunsPerProvider !== preferences.subagents.maxConcurrentRunsPerProvider ||
    subagentsMaxConcurrentRunsPerWorkspaceTarget !== preferences.subagents.maxConcurrentRunsPerWorkspaceTarget ||
    subagentsMaxTokens !== preferences.subagents.maxTokens ||
    subagentsHeartbeatIntervalSeconds !== preferences.subagents.heartbeatIntervalSeconds ||
    JSON.stringify(subagentRoles) !== JSON.stringify(preferences.subagents.roles);

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
    setSubagentDelegationMode(preferences.subagents.delegationMode);
    setSubagentsUseDefaultModel(!preferences.subagents.defaultModelRef);
    setSubagentsProvider(preferences.subagents.defaultModelRef?.providerId ?? preferences.defaultChatProvider);
    setSubagentsModel(preferences.subagents.defaultModelRef?.modelId ?? preferences.defaultChatModel);
    setSubagentRoles(preferences.subagents.roles);
    setSubagentsMaxConcurrentRuns(preferences.subagents.maxConcurrentRuns);
    setSubagentsMaxConcurrentRunsPerProvider(preferences.subagents.maxConcurrentRunsPerProvider);
    setSubagentsMaxConcurrentRunsPerWorkspaceTarget(preferences.subagents.maxConcurrentRunsPerWorkspaceTarget);
    setSubagentsMaxTokens(preferences.subagents.maxTokens);
    setSubagentsHeartbeatIntervalSeconds(preferences.subagents.heartbeatIntervalSeconds);
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

  function changeSubagentsProvider(provider: ChatProvider) {
    setSubagentsProvider(provider);
    setSubagentsModel((current) => normalizeChatModel(provider, current, providers));
  }

  function subagentDefaultProvider() {
    return subagentsUseDefaultModel ? preferences.defaultChatProvider : subagentsProvider;
  }

  function subagentDefaultModel() {
    return subagentsUseDefaultModel ? preferences.defaultChatModel : subagentsModel;
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
      const provider = role.modelRef?.providerId ?? subagentDefaultProvider();
      const model = role.modelRef?.modelId ?? subagentDefaultModel();
      return {
        ...role,
        modelRef: modelRefForTurn(provider, model, providers) ?? null,
      };
    });
  }

  function changeSubagentRoleProvider(roleId: string, provider: ChatProvider) {
    updateSubagentRole(roleId, (role) => ({
      ...role,
      modelRef: modelRefForTurn(provider, role.modelRef?.modelId ?? subagentDefaultModel(), providers) ?? null,
    }));
  }

  function setSubagentRoleModel(roleId: string, model: string) {
    updateSubagentRole(roleId, (role) => {
      const provider = role.modelRef?.providerId ?? subagentDefaultProvider();
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
            workspaceDefaultsVersion: preferences.subagents.workspaceDefaultsVersion,
            delegationMode: subagentDelegationMode,
            defaultModelRef: subagentsUseDefaultModel
              ? null
              : modelRefForTurn(subagentsProvider, subagentsModel, providers) ?? null,
            roles: subagentRoles,
            maxConcurrentRuns: clampInteger(subagentsMaxConcurrentRuns, 1, 32),
            maxConcurrentRunsPerProvider: subagentsMaxConcurrentRunsPerProvider === null
              ? null
              : clampInteger(subagentsMaxConcurrentRunsPerProvider, 1, 32),
            maxConcurrentRunsPerWorkspaceTarget: subagentsMaxConcurrentRunsPerWorkspaceTarget === null
              ? null
              : clampInteger(subagentsMaxConcurrentRunsPerWorkspaceTarget, 1, 32),
            maxTokens: subagentsMaxTokens === null ? null : clampInteger(subagentsMaxTokens, 1, 50_000_000),
            heartbeatIntervalSeconds: clampInteger(subagentsHeartbeatIntervalSeconds, 10, 3600),
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
    subagentDelegationMode,
    subagentsUseDefaultModel,
    subagentsProvider,
    subagentsModel,
    subagentRoles,
    subagentsMaxConcurrentRuns,
    subagentsMaxConcurrentRunsPerProvider,
    subagentsMaxConcurrentRunsPerWorkspaceTarget,
    subagentsMaxTokens,
    subagentsHeartbeatIntervalSeconds,
    subagentsDirty,
    saving,
    chooseDefaultProjectDirectory,
    saveDefaults,
    changeInsightsProvider,
    changeSubagentsProvider,
    changeSubagentRoleProvider,
    setAdvancedWorkspaceControls,
    setContextCompactionAutoEnabled,
    setDefaultBranchPrefix,
    setDefaultNewProjectDirectory,
    setGoalStorageLocation,
    setInsightsEnabled,
    setInsightsUseDefaultModel,
    setInsightsModel,
    setSubagentsUseDefaultModel,
    setSubagentsModel,
    setInsightsEvidenceSourceEnabled: (key: keyof InsightsEvidenceSourceSettings, enabled: boolean) =>
      setInsightsEvidenceSources((current) => ({ ...current, [key]: enabled })),
    setSubagentsEnabled,
    setSubagentDelegationMode: (value: SubagentDelegationMode) => setSubagentDelegationMode(value),
    setSubagentsMaxConcurrentRuns: (value: number) => setSubagentsMaxConcurrentRuns(clampInteger(value, 1, 32)),
    setSubagentsMaxConcurrentRunsPerProvider: (value: number | null) =>
      setSubagentsMaxConcurrentRunsPerProvider(value === null ? null : clampInteger(value, 1, 32)),
    setSubagentsMaxConcurrentRunsPerWorkspaceTarget: (value: number | null) =>
      setSubagentsMaxConcurrentRunsPerWorkspaceTarget(value === null ? null : clampInteger(value, 1, 32)),
    setSubagentsMaxTokens: (value: number | null) => setSubagentsMaxTokens(value),
    setSubagentsHeartbeatIntervalSeconds: (value: number) =>
      setSubagentsHeartbeatIntervalSeconds(clampInteger(value, 10, 3600)),
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

function chatModelRefsEqual(
  left: AppPreferences["subagents"]["defaultModelRef"],
  right: AppPreferences["subagents"]["defaultModelRef"],
): boolean {
  return (left?.providerId ?? null) === (right?.providerId ?? null) && (left?.modelId ?? null) === (right?.modelId ?? null);
}
