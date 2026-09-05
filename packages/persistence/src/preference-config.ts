import { AppPreferencesSchema, type AppPreferences } from "./schemas/settings.js";
import { type ChatModelRef } from "./schemas/providers.js";
import { type SubagentRoleSettings } from "./schemas/subagents.js";
import type { ConfigDocument, ConfigModel } from "./config-schema.js";

export const LAYOUT_PREFERENCE_KEYS = ["sidebarWidth", "diffPanelWidth", "sidebarSectionsCollapsed"] as const;
export type LayoutPreferences = Pick<AppPreferences, typeof LAYOUT_PREFERENCE_KEYS[number]>;
const modelToConfig = (ref: ChatModelRef): ConfigModel => ({ provider_id: ref.providerId, model_id: ref.modelId });
const modelFromConfig = (ref: ConfigModel): ChatModelRef => ({ providerId: ref.provider_id, modelId: ref.model_id });
const modelOverride = (ref: ChatModelRef | null) => ref ? { mode: "custom" as const, ref: modelToConfig(ref) } : { mode: "inherit" as const };

export function preferencesToConfig(value: AppPreferences): ConfigDocument {
  const preferences = AppPreferencesSchema.parse(value);
  return {
    schema_version: 1,
    chat: { model: modelToConfig(preferences.defaultChatModelRef ?? { providerId: preferences.defaultChatProvider, modelId: preferences.defaultChatModel }), steer_active_responses: preferences.steerActiveResponses },
    codex: { reasoning_effort: preferences.codexReasoningEffort },
    permissions: { command_access: preferences.openPondCommandAccessMode, codex_mode: preferences.codexPermissionMode },
    context_compaction: { auto_enabled: preferences.contextCompaction.autoEnabled, trigger_percent: preferences.contextCompaction.triggerPercent, summary_model: preferences.contextCompaction.summaryModel },
    projects: { branch_prefix: preferences.defaultBranchPrefix, new_project_directory: preferences.defaultNewProjectDirectory },
    defaults: { ...(preferences.defaultTeamId ? { team_id: preferences.defaultTeamId } : {}) },
    ui: { advanced_workspace_controls: preferences.advancedWorkspaceControls },
    editor: { language_servers: preferences.editor.languageServers, diagnostics_while_editing: preferences.editor.diagnosticsWhileEditing, check_on_save: preferences.editor.checkOnSave,
      languages: Object.fromEntries(Object.entries(preferences.editor.languages).map(([id, language]) => [id, { mode: language.mode, custom_command: language.customCommand }])) },
    training: { default_model: modelOverride(preferences.training.defaultModelRef), creation_mode: preferences.training.creationMode, auto_approve_evidence: preferences.training.autoApproveEvidence },
    subagents: { enabled: preferences.subagents.enabled, delegation_mode: preferences.subagents.delegationMode,
      default_model: modelOverride(preferences.subagents.defaultModelRef), max_concurrent_runs: preferences.subagents.maxConcurrentRuns,
      max_concurrent_runs_per_provider: preferences.subagents.maxConcurrentRunsPerProvider ?? "unlimited",
      max_concurrent_runs_per_workspace_target: preferences.subagents.maxConcurrentRunsPerWorkspaceTarget ?? "unlimited",
      roles: Object.fromEntries(preferences.subagents.roles.map((role) => [role.id, { enabled: role.enabled, model: modelOverride(role.modelRef), isolation_mode: role.isolationMode, max_concurrent_runs: role.maxConcurrentRuns, tool_policy: role.toolPolicy, background: role.background, peer_messages: role.peerMessages }])) },
  };
}

export function configToPreferences(config: ConfigDocument, layout: Partial<LayoutPreferences> = {}): AppPreferences {
  const base = AppPreferencesSchema.parse({});
  const model = config.chat?.model ? modelFromConfig(config.chat.model) : { providerId: base.defaultChatProvider, modelId: base.defaultChatModel };
  const sub = config.subagents;
  const roles = new Map<string, SubagentRoleSettings>(base.subagents.roles.map((role) => [role.id, role]));
  for (const [id, role] of Object.entries(sub?.roles ?? {})) {
    const current = roles.get(id);
    roles.set(id, { id, enabled: role.enabled ?? current?.enabled ?? true,
      modelRef: role.model ? (role.model.mode === "custom" ? modelFromConfig(role.model.ref) : null) : current?.modelRef ?? null,
      isolationMode: role.isolation_mode ?? current?.isolationMode ?? "none", maxConcurrentRuns: role.max_concurrent_runs ?? current?.maxConcurrentRuns ?? 1,
      toolPolicy: role.tool_policy ?? current?.toolPolicy ?? "read_only", background: role.background ?? current?.background ?? true, peerMessages: role.peer_messages ?? current?.peerMessages ?? "parent_scoped" });
  }
  return AppPreferencesSchema.parse({
    ...base, ...layout, defaultChatProvider: model.providerId, defaultChatModel: model.modelId, defaultChatModelRef: model,
    codexReasoningEffort: config.codex?.reasoning_effort ?? base.codexReasoningEffort,
    codexPermissionMode: config.permissions?.codex_mode ?? base.codexPermissionMode,
    openPondCommandAccessMode: config.permissions?.command_access ?? base.openPondCommandAccessMode,
    defaultBranchPrefix: config.projects?.branch_prefix ?? base.defaultBranchPrefix,
    defaultNewProjectDirectory: config.projects?.new_project_directory ?? base.defaultNewProjectDirectory,
    defaultTeamId: config.defaults?.team_id ?? null,
    advancedWorkspaceControls: config.ui?.advanced_workspace_controls ?? base.advancedWorkspaceControls,
    steerActiveResponses: config.chat?.steer_active_responses ?? base.steerActiveResponses,
    contextCompaction: { autoEnabled: config.context_compaction?.auto_enabled ?? base.contextCompaction.autoEnabled, triggerPercent: config.context_compaction?.trigger_percent ?? base.contextCompaction.triggerPercent, summaryModel: config.context_compaction?.summary_model ?? base.contextCompaction.summaryModel },
    training: { defaultModelRef: config.training?.default_model?.mode === "custom" ? modelFromConfig(config.training.default_model.ref) : null, creationMode: config.training?.creation_mode ?? base.training.creationMode, autoApproveEvidence: config.training?.auto_approve_evidence ?? base.training.autoApproveEvidence },
    editor: { languageServers: config.editor?.language_servers ?? base.editor.languageServers, diagnosticsWhileEditing: config.editor?.diagnostics_while_editing ?? base.editor.diagnosticsWhileEditing, checkOnSave: config.editor?.check_on_save ?? base.editor.checkOnSave,
      languages: Object.fromEntries(Object.entries(base.editor.languages).map(([id, language]) => { const value = config.editor?.languages?.[id as keyof typeof base.editor.languages]; return [id, { mode: value?.mode ?? language.mode, customCommand: value?.custom_command ?? language.customCommand }]; })) },
    subagents: { ...base.subagents, enabled: sub?.enabled ?? base.subagents.enabled, delegationMode: sub?.delegation_mode ?? base.subagents.delegationMode,
      defaultModelRef: sub?.default_model?.mode === "custom" ? modelFromConfig(sub.default_model.ref) : null, roles: [...roles.values()],
      maxConcurrentRuns: sub?.max_concurrent_runs ?? base.subagents.maxConcurrentRuns,
      maxConcurrentRunsPerProvider: sub?.max_concurrent_runs_per_provider === "unlimited" ? null : sub?.max_concurrent_runs_per_provider ?? base.subagents.maxConcurrentRunsPerProvider,
      maxConcurrentRunsPerWorkspaceTarget: sub?.max_concurrent_runs_per_workspace_target === "unlimited" ? null : sub?.max_concurrent_runs_per_workspace_target ?? base.subagents.maxConcurrentRunsPerWorkspaceTarget },
  });
}

export function layoutPreferences(value: AppPreferences): LayoutPreferences {
  return { sidebarWidth: value.sidebarWidth, diffPanelWidth: value.diffPanelWidth, sidebarSectionsCollapsed: value.sidebarSectionsCollapsed };
}
