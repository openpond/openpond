import type { FormEvent } from "react";
import type {
  BootstrapPayload,
  ChatProvider,
  InsightsEvidenceSourceSettings,
  ProviderSettings,
  SubagentIsolationMode,
  SubagentPeerMessages,
  SubagentRoleSettings,
  SubagentToolPolicy,
} from "@openpond/contracts";
import { SUBAGENT_ROLE_PRESETS } from "@openpond/contracts";
import { FolderOpen } from "../icons";
import {
  chatModelLabel,
  chatProviderLabel,
  defaultModelForProvider,
  modelOptionsForProvider,
  normalizeBranchPrefix,
  providerOptionsFromSettings,
} from "../../lib/app-models";

type DefaultsSettingsSectionProps = {
  advancedWorkspaceControls: boolean;
  defaultBranchPrefix: string;
  defaultNewProjectDirectory: string;
  goalStorageLocation: BootstrapPayload["preferences"]["goalStorageLocation"];
  contextCompactionAutoEnabled: boolean;
  insightsEnabled: boolean;
  insightsUseDefaultModel: boolean;
  insightsProvider: ChatProvider;
  insightsModel: string;
  insightsEvidenceSources: InsightsEvidenceSourceSettings;
  subagentsEnabled: boolean;
  subagentRoles: SubagentRoleSettings[];
  subagentsMaxConcurrentRuns: number;
  subagentsMaxConcurrentRunsPerProvider: number | null;
  subagentsMaxConcurrentRunsPerWorkspaceTarget: number | null;
  subagentsMaxTokens: number | null;
  preferences: BootstrapPayload["preferences"];
  providers: ProviderSettings | null;
  saving: boolean;
  chooseDefaultProjectDirectory: () => void | Promise<void>;
  saveDefaults: (event: FormEvent<HTMLFormElement>) => void;
  changeInsightsProvider: (provider: ChatProvider) => void;
  setAdvancedWorkspaceControls: (value: boolean) => void;
  setContextCompactionAutoEnabled: (value: boolean) => void;
  setDefaultBranchPrefix: (value: string) => void;
  setDefaultNewProjectDirectory: (value: string) => void;
  setGoalStorageLocation: (value: BootstrapPayload["preferences"]["goalStorageLocation"]) => void;
  setInsightsEnabled: (value: boolean) => void;
  setInsightsUseDefaultModel: (value: boolean) => void;
  setInsightsModel: (value: string) => void;
  setInsightsEvidenceSourceEnabled: (key: keyof InsightsEvidenceSourceSettings, enabled: boolean) => void;
  setSubagentsEnabled: (value: boolean) => void;
  setSubagentsMaxConcurrentRuns: (value: number) => void;
  setSubagentsMaxConcurrentRunsPerProvider: (value: number | null) => void;
  setSubagentsMaxConcurrentRunsPerWorkspaceTarget: (value: number | null) => void;
  setSubagentsMaxTokens: (value: number | null) => void;
  setSubagentRoleBackground: (roleId: string, background: boolean) => void;
  setSubagentRoleEnabled: (roleId: string, enabled: boolean) => void;
  setSubagentRoleIsolationMode: (roleId: string, isolationMode: SubagentIsolationMode) => void;
  setSubagentRoleMaxConcurrentRuns: (roleId: string, value: number) => void;
  setSubagentRoleMaxTokens: (roleId: string, value: number | null) => void;
  setSubagentRoleMaxTurns: (roleId: string, value: number | null) => void;
  setSubagentRoleModel: (roleId: string, model: string) => void;
  setSubagentRolePeerMessages: (roleId: string, peerMessages: SubagentPeerMessages) => void;
  setSubagentRoleToolPolicy: (roleId: string, toolPolicy: SubagentToolPolicy) => void;
  setSubagentRoleUseDefaultModel: (roleId: string, useDefault: boolean) => void;
  changeSubagentRoleProvider: (roleId: string, provider: ChatProvider) => void;
};

export function DefaultsSettingsSection({
  advancedWorkspaceControls,
  defaultBranchPrefix,
  defaultNewProjectDirectory,
  goalStorageLocation,
  contextCompactionAutoEnabled,
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
  preferences,
  providers,
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
  setInsightsEvidenceSourceEnabled,
  setSubagentsEnabled,
  setSubagentsMaxConcurrentRuns,
  setSubagentsMaxConcurrentRunsPerProvider,
  setSubagentsMaxConcurrentRunsPerWorkspaceTarget,
  setSubagentsMaxTokens,
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
  changeSubagentRoleProvider,
}: DefaultsSettingsSectionProps) {
  const insightProviderOptions = providerOptionsFromSettings(providers, { enabledOnly: true });
  const insightModelOptions = modelOptionsForProvider(insightsProvider, providers);
  const insightModelDatalistId = "settings-insights-model-options";
  const subagentProviderOptions = providerOptionsFromSettings(providers, { enabledOnly: true });
  return (
    <section className="account-settings">
      <h1>Defaults</h1>
      <form className="provider-settings-form" onSubmit={(event) => void saveDefaults(event)}>
        <label className="settings-check-row">
          <input
            type="checkbox"
            checked={advancedWorkspaceControls}
            disabled={saving}
            onChange={(event) => setAdvancedWorkspaceControls(event.target.checked)}
          />
          <span>
            <strong>Show advanced Git controls</strong>
            <small>Show branch, commit, and push controls for local project workflows.</small>
          </span>
        </label>
        <div className="account-list-heading">
          <span>Git branches</span>
          <small>Used for advanced and non-managed branch creation</small>
        </div>
        <div className="provider-settings-grid single">
          <label className="settings-select-field">
            <span>Branch prefix</span>
            <input
              value={defaultBranchPrefix}
              disabled={saving}
              placeholder="feat/"
              onChange={(event) => setDefaultBranchPrefix(event.target.value)}
            />
          </label>
        </div>
        <div className="account-list-heading">
          <span>Projects</span>
          <small>Used when starting a new local project from scratch</small>
        </div>
        <div className="settings-path-row">
          <label className="settings-select-field">
            <span>New project directory</span>
            <input
              value={defaultNewProjectDirectory}
              disabled={saving}
              placeholder="~/Documents/OpenPond Projects"
              onChange={(event) => setDefaultNewProjectDirectory(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="settings-secondary"
            disabled={saving}
            onClick={() => void chooseDefaultProjectDirectory()}
          >
            <FolderOpen size={14} />
            <span>Browse</span>
          </button>
        </div>
        <div className="account-list-heading">
          <span>Goals</span>
          <small>Controls where local goal state, plans, and artifacts are written</small>
        </div>
        <div className="settings-radio-group">
          <label className="settings-radio-row">
            <input
              type="radio"
              name="goal-storage-location"
              checked={goalStorageLocation === "global"}
              disabled={saving}
              onChange={() => setGoalStorageLocation("global")}
            />
            <span>
              <strong>User home</strong>
              <small>Store goal files under ~/.openpond/goals.</small>
            </span>
          </label>
          <label className="settings-radio-row">
            <input
              type="radio"
              name="goal-storage-location"
              checked={goalStorageLocation === "workspace"}
              disabled={saving}
              onChange={() => setGoalStorageLocation("workspace")}
            />
            <span>
              <strong>Working directory</strong>
              <small>Store goal files in the current workspace under .openpond/goals.</small>
            </span>
          </label>
        </div>
        <div className="account-list-heading">
          <span>Context</span>
          <small>Controls automatic compaction for long OpenPond and BYOK chats</small>
        </div>
        <label className="settings-check-row">
          <input
            type="checkbox"
            checked={contextCompactionAutoEnabled}
            disabled={saving}
            onChange={(event) => setContextCompactionAutoEnabled(event.target.checked)}
          />
          <span>
            <strong>Auto compact long chats</strong>
            <small>Summarize older turns at 85% context before the selected model runs out. The transcript stays visible.</small>
          </span>
        </label>
        <div className="account-list-heading">
          <span>Insights</span>
          <small>Controls the background Insights agent</small>
        </div>
        <label className="settings-check-row">
          <input
            type="checkbox"
            checked={insightsEnabled}
            disabled={saving}
            onChange={(event) => setInsightsEnabled(event.target.checked)}
          />
          <span>
            <strong>Run background Insights</strong>
            <small>Startup and interval scans run while the app is open.</small>
          </span>
        </label>
        <label className="settings-check-row">
          <input
            type="checkbox"
            checked={insightsUseDefaultModel}
            disabled={saving}
            onChange={(event) => setInsightsUseDefaultModel(event.target.checked)}
          />
          <span>
            <strong>Use default chat model</strong>
            <small>
              {chatProviderLabel(preferences.defaultChatProvider, providers)} /{" "}
              {chatModelLabel(preferences.defaultChatModel, providers, preferences.defaultChatProvider)}
            </small>
          </span>
        </label>
        {!insightsUseDefaultModel ? (
          <div className="provider-settings-grid two">
            <label className="settings-select-field">
              <span>Insights provider</span>
              <select
                value={insightsProvider}
                disabled={saving}
                onChange={(event) => changeInsightsProvider(event.target.value as ChatProvider)}
              >
                {insightProviderOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-select-field">
              <span>Insights model</span>
              <input
                value={insightsModel}
                disabled={saving}
                list={insightModelDatalistId}
                onChange={(event) => setInsightsModel(event.target.value)}
              />
              <datalist id={insightModelDatalistId}>
                {insightModelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </datalist>
            </label>
          </div>
        ) : null}
        <div className="settings-check-grid" aria-label="Insights evidence sources">
          {INSIGHTS_EVIDENCE_SOURCE_OPTIONS.map((option) => (
            <label className="settings-check-row compact" key={option.key}>
              <input
                type="checkbox"
                checked={insightsEvidenceSources[option.key]}
                disabled={saving}
                onChange={(event) => setInsightsEvidenceSourceEnabled(option.key, event.target.checked)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}
        </div>
        <div className="account-list-heading">
          <span>Subagents</span>
          <small>Controls background specialist child conversations</small>
        </div>
        <label className="settings-check-row">
          <input
            type="checkbox"
            checked={subagentsEnabled}
            disabled={saving}
            onChange={(event) => setSubagentsEnabled(event.target.checked)}
          />
          <span>
            <strong>Allow subagents</strong>
            <small>Goal runs can start background child conversations with receipts.</small>
          </span>
        </label>
        <div className="provider-settings-grid two">
          <label className="settings-select-field">
            <span>Total concurrency</span>
            <input
              type="number"
              min={1}
              max={32}
              value={subagentsMaxConcurrentRuns}
              disabled={saving || !subagentsEnabled}
              onChange={(event) => setSubagentsMaxConcurrentRuns(numberOrDefault(event.target.value, 1))}
            />
          </label>
          <label className="settings-select-field">
            <span>Per provider</span>
            <input
              type="number"
              min={1}
              max={32}
              value={subagentsMaxConcurrentRunsPerProvider ?? ""}
              placeholder="No cap"
              disabled={saving || !subagentsEnabled}
              onChange={(event) => setSubagentsMaxConcurrentRunsPerProvider(nullableNumber(event.target.value))}
            />
          </label>
          <label className="settings-select-field">
            <span>Per workspace</span>
            <input
              type="number"
              min={1}
              max={32}
              value={subagentsMaxConcurrentRunsPerWorkspaceTarget ?? ""}
              placeholder="No cap"
              disabled={saving || !subagentsEnabled}
              onChange={(event) => setSubagentsMaxConcurrentRunsPerWorkspaceTarget(nullableNumber(event.target.value))}
            />
          </label>
          <label className="settings-select-field">
            <span>Total token cap</span>
            <input
              type="number"
              min={1}
              max={50_000_000}
              value={subagentsMaxTokens ?? ""}
              placeholder="No cap"
              disabled={saving || !subagentsEnabled}
              onChange={(event) => setSubagentsMaxTokens(nullableNumber(event.target.value))}
            />
          </label>
        </div>
        <div className="subagent-role-list">
          {subagentRoles.map((role) => {
            const preset = SUBAGENT_ROLE_PRESETS.find((candidate) => candidate.id === role.id);
            const roleProvider = role.modelRef?.providerId ?? preferences.defaultChatProvider;
            const roleModel =
              role.modelRef?.modelId ??
              defaultModelForProvider(roleProvider, providers) ??
              preferences.defaultChatModel;
            const roleModelOptions = modelOptionsForProvider(roleProvider, providers);
            const roleModelDatalistId = `settings-subagent-${role.id}-model-options`;
            const useDefaultModel = !role.modelRef;
            const roleDisabled = saving || !subagentsEnabled || !role.enabled;
            return (
              <section className={`subagent-role-row${role.enabled ? "" : " disabled"}`} key={role.id}>
                <div className="subagent-role-header">
                  <label className="provider-toggle" aria-label={`${preset?.label ?? role.id} enabled`}>
                    <input
                      type="checkbox"
                      checked={role.enabled}
                      disabled={saving || !subagentsEnabled}
                      onChange={(event) => setSubagentRoleEnabled(role.id, event.target.checked)}
                    />
                    <span />
                  </label>
                  <div className="subagent-role-title">
                    <strong>{preset?.label ?? role.id}</strong>
                    <small>{preset?.description ?? "Custom subagent role."}</small>
                  </div>
                </div>
                <div className="subagent-role-controls">
                  <label className="settings-check-row compact inline">
                    <input
                      type="checkbox"
                      checked={useDefaultModel}
                      disabled={roleDisabled}
                      onChange={(event) => setSubagentRoleUseDefaultModel(role.id, event.target.checked)}
                    />
                    <span>
                      <strong>Use main model</strong>
                      <small>
                        {chatProviderLabel(preferences.defaultChatProvider, providers)} /{" "}
                        {chatModelLabel(preferences.defaultChatModel, providers, preferences.defaultChatProvider)}
                      </small>
                    </span>
                  </label>
                  {!useDefaultModel ? (
                    <>
                      <label className="settings-select-field">
                        <span>Provider</span>
                        <select
                          value={roleProvider}
                          disabled={roleDisabled}
                          onChange={(event) => changeSubagentRoleProvider(role.id, event.target.value as ChatProvider)}
                        >
                          {subagentProviderOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="settings-select-field">
                        <span>Model</span>
                        <input
                          value={roleModel}
                          disabled={roleDisabled}
                          list={roleModelDatalistId}
                          onChange={(event) => setSubagentRoleModel(role.id, event.target.value)}
                        />
                        <datalist id={roleModelDatalistId}>
                          {roleModelOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </datalist>
                      </label>
                    </>
                  ) : null}
                  <label className="settings-select-field">
                    <span>Isolation</span>
                    <select
                      value={role.isolationMode}
                      disabled={roleDisabled}
                      onChange={(event) =>
                        setSubagentRoleIsolationMode(role.id, event.target.value as SubagentIsolationMode)
                      }
                    >
                      {SUBAGENT_ISOLATION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-select-field">
                    <span>Tools</span>
                    <select
                      value={role.toolPolicy}
                      disabled={roleDisabled}
                      onChange={(event) => setSubagentRoleToolPolicy(role.id, event.target.value as SubagentToolPolicy)}
                    >
                      {SUBAGENT_TOOL_POLICY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-select-field">
                    <span>Peer messages</span>
                    <select
                      value={role.peerMessages}
                      disabled={roleDisabled}
                      onChange={(event) =>
                        setSubagentRolePeerMessages(role.id, event.target.value as SubagentPeerMessages)
                      }
                    >
                      {SUBAGENT_PEER_MESSAGE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-check-row compact inline">
                    <input
                      type="checkbox"
                      checked={role.background}
                      disabled={roleDisabled}
                      onChange={(event) => setSubagentRoleBackground(role.id, event.target.checked)}
                    />
                    <span>
                      <strong>Background</strong>
                      <small>Run as a child conversation with receipts.</small>
                    </span>
                  </label>
                  <label className="settings-select-field">
                    <span>Role concurrency</span>
                    <input
                      type="number"
                      min={1}
                      max={16}
                      value={role.maxConcurrentRuns}
                      disabled={roleDisabled}
                      onChange={(event) => setSubagentRoleMaxConcurrentRuns(role.id, numberOrDefault(event.target.value, 1))}
                    />
                  </label>
                  <label className="settings-select-field">
                    <span>Turn cap</span>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={role.maxTurns ?? ""}
                      placeholder="No cap"
                      disabled={roleDisabled}
                      onChange={(event) => setSubagentRoleMaxTurns(role.id, nullableNumber(event.target.value))}
                    />
                  </label>
                  <label className="settings-select-field">
                    <span>Token cap</span>
                    <input
                      type="number"
                      min={1}
                      max={10_000_000}
                      value={role.maxTokens ?? ""}
                      placeholder="No cap"
                      disabled={roleDisabled}
                      onChange={(event) => setSubagentRoleMaxTokens(role.id, nullableNumber(event.target.value))}
                    />
                  </label>
                </div>
              </section>
            );
          })}
        </div>
        <button
          className="settings-primary"
          disabled={
            saving ||
            (normalizeBranchPrefix(defaultBranchPrefix) === preferences.defaultBranchPrefix &&
              defaultNewProjectDirectory.trim() === preferences.defaultNewProjectDirectory &&
              goalStorageLocation === preferences.goalStorageLocation &&
              advancedWorkspaceControls === preferences.advancedWorkspaceControls &&
              contextCompactionAutoEnabled === preferences.contextCompaction.autoEnabled &&
              insightsEnabled === preferences.insightsEnabled &&
              insightEvidenceSourcesEqual(insightsEvidenceSources, preferences.insightsEvidenceSources) &&
              insightModelSettingsEqual({
                useDefault: insightsUseDefaultModel,
                provider: insightsProvider,
                model: insightsModel,
              }, preferences) &&
              subagentSettingsEqual({
                enabled: subagentsEnabled,
                roles: subagentRoles,
                maxConcurrentRuns: subagentsMaxConcurrentRuns,
                maxConcurrentRunsPerProvider: subagentsMaxConcurrentRunsPerProvider,
                maxConcurrentRunsPerWorkspaceTarget: subagentsMaxConcurrentRunsPerWorkspaceTarget,
                maxTokens: subagentsMaxTokens,
              }, preferences))
          }
        >
          <span>{saving ? "Saving" : "Save defaults"}</span>
        </button>
      </form>

      <div className="settings-footnote">
        <span>Initial branch name</span>
        <strong>{normalizeBranchPrefix(defaultBranchPrefix)}example-project</strong>
      </div>
      <div className="settings-footnote">
        <span>New projects</span>
        <strong>{defaultNewProjectDirectory || preferences.defaultNewProjectDirectory}</strong>
      </div>
      <div className="settings-footnote">
        <span>Goal storage</span>
        <strong>{goalStorageLocation === "global" ? "~/.openpond/goals" : ".openpond/goals in the working directory"}</strong>
      </div>
      <div className="settings-footnote">
        <span>Insights model</span>
        <strong>
          {insightsUseDefaultModel
            ? "Default chat model"
            : `${chatProviderLabel(insightsProvider, providers)} / ${insightsModel}`}
        </strong>
      </div>
      <div className="settings-footnote">
        <span>Coding subagent</span>
        <strong>{subagentRoleSummary(subagentRoles.find((role) => role.id === "coding") ?? null, preferences, providers)}</strong>
      </div>
    </section>
  );
}

const SUBAGENT_ISOLATION_OPTIONS: Array<{ value: SubagentIsolationMode; label: string }> = [
  { value: "copy_on_write", label: "Copy-on-write" },
  { value: "worktree", label: "Worktree" },
  { value: "none", label: "None" },
];

const SUBAGENT_TOOL_POLICY_OPTIONS: Array<{ value: SubagentToolPolicy; label: string }> = [
  { value: "read_only", label: "Read only" },
  { value: "workspace_write", label: "Workspace write" },
  { value: "full_tools", label: "Full tools" },
];

const SUBAGENT_PEER_MESSAGE_OPTIONS: Array<{ value: SubagentPeerMessages; label: string }> = [
  { value: "goal_scoped", label: "Goal scoped" },
  { value: "disabled", label: "Disabled" },
];

const INSIGHTS_EVIDENCE_SOURCE_OPTIONS: Array<{
  key: keyof InsightsEvidenceSourceSettings;
  label: string;
  description: string;
}> = [
  { key: "createEdit", label: "Create/edit", description: "Waiting, blocked, or failed create/edit flows." },
  { key: "stuckTurns", label: "Stuck turns", description: "Failed or long-running active turns." },
  { key: "toolFailures", label: "Tool failures", description: "Repeated tool or action failures." },
  { key: "abandonedGoals", label: "Abandoned goals", description: "Goal loops left active too long." },
  { key: "userCorrections", label: "Corrections", description: "Repeated correction-style prompts." },
  { key: "unresolvedConversations", label: "Unresolved chats", description: "Long chats with unresolved recent work." },
  { key: "usageAnomalies", label: "Usage", description: "Spikes, failures, missing usage, and latency changes." },
];

function insightEvidenceSourcesEqual(
  current: InsightsEvidenceSourceSettings,
  preferences: BootstrapPayload["preferences"]["insightsEvidenceSources"],
): boolean {
  return INSIGHTS_EVIDENCE_SOURCE_OPTIONS.every((option) => current[option.key] === preferences[option.key]);
}

function insightModelSettingsEqual(
  current: { useDefault: boolean; provider: ChatProvider; model: string },
  preferences: BootstrapPayload["preferences"],
): boolean {
  if (current.useDefault) return !preferences.insightsModelRef;
  return (
    preferences.insightsModelRef?.providerId === current.provider &&
    preferences.insightsModelRef?.modelId === current.model.trim()
  );
}

function nullableNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrDefault(value: string, fallback: number): number {
  const parsed = nullableNumber(value);
  return parsed ?? fallback;
}

function subagentSettingsEqual(
  current: {
    enabled: boolean;
    roles: SubagentRoleSettings[];
    maxConcurrentRuns: number;
    maxConcurrentRunsPerProvider: number | null;
    maxConcurrentRunsPerWorkspaceTarget: number | null;
    maxTokens: number | null;
  },
  preferences: BootstrapPayload["preferences"],
): boolean {
  const saved = preferences.subagents;
  return (
    current.enabled === saved.enabled &&
    current.maxConcurrentRuns === saved.maxConcurrentRuns &&
    current.maxConcurrentRunsPerProvider === saved.maxConcurrentRunsPerProvider &&
    current.maxConcurrentRunsPerWorkspaceTarget === saved.maxConcurrentRunsPerWorkspaceTarget &&
    current.maxTokens === saved.maxTokens &&
    JSON.stringify(current.roles) === JSON.stringify(saved.roles)
  );
}

function subagentRoleSummary(
  role: SubagentRoleSettings | null,
  preferences: BootstrapPayload["preferences"],
  providers: ProviderSettings | null,
): string {
  if (!role) return "Not configured";
  if (!role.enabled) return "Disabled";
  const model = role.modelRef
    ? `${chatProviderLabel(role.modelRef.providerId, providers)} / ${role.modelRef.modelId}`
    : `${chatProviderLabel(preferences.defaultChatProvider, providers)} / ${chatModelLabel(
        preferences.defaultChatModel,
        providers,
        preferences.defaultChatProvider,
      )}`;
  return `${model} · ${SUBAGENT_ISOLATION_OPTIONS.find((option) => option.value === role.isolationMode)?.label ?? role.isolationMode}`;
}
