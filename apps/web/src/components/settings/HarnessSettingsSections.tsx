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
import {
  chatModelLabel,
  chatProviderLabel,
  defaultModelForProvider,
  type DropdownOption,
  modelOptionsForProvider,
  providerOptionsFromSettings,
} from "../../lib/app-models";

type SharedHarnessSettingsProps = {
  preferences: BootstrapPayload["preferences"];
  saving: boolean;
  saveDefaults: (event: FormEvent<HTMLFormElement>) => void;
};

type GoalsSettingsSectionProps = SharedHarnessSettingsProps & {
  goalStorageLocation: BootstrapPayload["preferences"]["goalStorageLocation"];
  setGoalStorageLocation: (value: BootstrapPayload["preferences"]["goalStorageLocation"]) => void;
};

type ContextSettingsSectionProps = SharedHarnessSettingsProps & {
  contextCompactionAutoEnabled: boolean;
  setContextCompactionAutoEnabled: (value: boolean) => void;
};

type InsightsSettingsSectionProps = SharedHarnessSettingsProps & {
  insightsEnabled: boolean;
  insightsUseDefaultModel: boolean;
  insightsProvider: ChatProvider;
  insightsModel: string;
  insightsEvidenceSources: InsightsEvidenceSourceSettings;
  providers: ProviderSettings | null;
  changeInsightsProvider: (provider: ChatProvider) => void;
  setInsightsEnabled: (value: boolean) => void;
  setInsightsUseDefaultModel: (value: boolean) => void;
  setInsightsModel: (value: string) => void;
  setInsightsEvidenceSourceEnabled: (key: keyof InsightsEvidenceSourceSettings, enabled: boolean) => void;
};

type SubagentsSettingsSectionProps = SharedHarnessSettingsProps & {
  subagentsEnabled: boolean;
  subagentsUseDefaultModel: boolean;
  subagentsProvider: ChatProvider;
  subagentsModel: string;
  subagentRoles: SubagentRoleSettings[];
  subagentsMaxConcurrentRuns: number;
  subagentsMaxConcurrentRunsPerProvider: number | null;
  subagentsMaxConcurrentRunsPerWorkspaceTarget: number | null;
  subagentsMaxTokens: number | null;
  subagentsHeartbeatIntervalSeconds: number;
  providers: ProviderSettings | null;
  changeSubagentsProvider: (provider: ChatProvider) => void;
  setSubagentsEnabled: (value: boolean) => void;
  setSubagentsUseDefaultModel: (value: boolean) => void;
  setSubagentsModel: (value: string) => void;
  setSubagentsMaxConcurrentRuns: (value: number) => void;
  setSubagentsMaxConcurrentRunsPerProvider: (value: number | null) => void;
  setSubagentsMaxConcurrentRunsPerWorkspaceTarget: (value: number | null) => void;
  setSubagentsMaxTokens: (value: number | null) => void;
  setSubagentsHeartbeatIntervalSeconds: (value: number) => void;
  setSubagentRoleEnabled: (roleId: string, enabled: boolean) => void;
  setSubagentRoleIsolationMode: (roleId: string, isolationMode: SubagentIsolationMode) => void;
  setSubagentRoleMaxConcurrentRuns: (roleId: string, value: number) => void;
  setSubagentRoleMaxTokens: (roleId: string, value: number | null) => void;
  setSubagentRoleMaxTurns: (roleId: string, value: number | null) => void;
  setSubagentRoleModel: (roleId: string, model: string) => void;
  setSubagentRolePeerMessages: (roleId: string, peerMessages: SubagentPeerMessages) => void;
  setSubagentRoleToolPolicy: (roleId: string, toolPolicy: SubagentToolPolicy) => void;
  changeSubagentRoleProvider: (roleId: string, provider: ChatProvider) => void;
};

export function GoalsSettingsSection({
  goalStorageLocation,
  preferences,
  saving,
  saveDefaults,
  setGoalStorageLocation,
}: GoalsSettingsSectionProps) {
  return (
    <section className="account-settings">
      <h1>Goals</h1>
      <form className="provider-settings-form" onSubmit={(event) => void saveDefaults(event)}>
        <div className="account-list-heading">
          <span>Storage</span>
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
        <button className="settings-primary" disabled={saving || goalStorageLocation === preferences.goalStorageLocation}>
          <span>{saving ? "Saving" : "Save goals"}</span>
        </button>
      </form>

      <div className="settings-footnote">
        <span>Goal storage</span>
        <strong>{goalStorageLocation === "global" ? "~/.openpond/goals" : ".openpond/goals in the working directory"}</strong>
      </div>
    </section>
  );
}

export function ContextSettingsSection({
  contextCompactionAutoEnabled,
  preferences,
  saving,
  saveDefaults,
  setContextCompactionAutoEnabled,
}: ContextSettingsSectionProps) {
  return (
    <section className="account-settings">
      <h1>Context</h1>
      <form className="provider-settings-form" onSubmit={(event) => void saveDefaults(event)}>
        <div className="account-list-heading">
          <span>Compaction</span>
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
        <button
          className="settings-primary"
          disabled={saving || contextCompactionAutoEnabled === preferences.contextCompaction.autoEnabled}
        >
          <span>{saving ? "Saving" : "Save context"}</span>
        </button>
      </form>
    </section>
  );
}

export function InsightsSettingsSection({
  insightsEnabled,
  insightsUseDefaultModel,
  insightsProvider,
  insightsModel,
  insightsEvidenceSources,
  preferences,
  providers,
  saving,
  saveDefaults,
  changeInsightsProvider,
  setInsightsEnabled,
  setInsightsUseDefaultModel,
  setInsightsModel,
  setInsightsEvidenceSourceEnabled,
}: InsightsSettingsSectionProps) {
  const insightProviderOptions = providerOptionsFromSettings(providers, { enabledOnly: true });
  const insightModelOptions = modelOptionsForProvider(insightsProvider, providers);
  const insightModelDatalistId = "settings-insights-model-options";
  const unchanged =
    insightsEnabled === preferences.insightsEnabled &&
    insightEvidenceSourcesEqual(insightsEvidenceSources, preferences.insightsEvidenceSources) &&
    insightModelSettingsEqual(
      {
        useDefault: insightsUseDefaultModel,
        provider: insightsProvider,
        model: insightsModel,
      },
      preferences,
    );

  return (
    <section className="account-settings insights-settings">
      <h1>Insights</h1>
      <form className="provider-settings-form" onSubmit={(event) => void saveDefaults(event)}>
        <div className="account-list-heading">
          <span>Background agent</span>
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
        <button className="settings-primary" disabled={saving || unchanged}>
          <span>{saving ? "Saving" : "Save insights"}</span>
        </button>
      </form>

      <div className="settings-footnote">
        <span>Insights model</span>
        <strong>
          {insightsUseDefaultModel
            ? "Default chat model"
            : `${chatProviderLabel(insightsProvider, providers)} / ${insightsModel}`}
        </strong>
      </div>
    </section>
  );
}

export function SubagentsSettingsSection({
  subagentsEnabled,
  subagentsUseDefaultModel,
  subagentsProvider,
  subagentsModel,
  subagentRoles,
  subagentsMaxConcurrentRuns,
  subagentsMaxConcurrentRunsPerProvider,
  subagentsMaxConcurrentRunsPerWorkspaceTarget,
  subagentsMaxTokens,
  subagentsHeartbeatIntervalSeconds,
  preferences,
  providers,
  saving,
  saveDefaults,
  changeSubagentsProvider,
  setSubagentsEnabled,
  setSubagentsUseDefaultModel,
  setSubagentsModel,
  setSubagentsMaxConcurrentRuns,
  setSubagentsMaxConcurrentRunsPerProvider,
  setSubagentsMaxConcurrentRunsPerWorkspaceTarget,
  setSubagentsMaxTokens,
  setSubagentsHeartbeatIntervalSeconds,
  setSubagentRoleEnabled,
  setSubagentRoleIsolationMode,
  setSubagentRoleMaxConcurrentRuns,
  setSubagentRoleMaxTokens,
  setSubagentRoleMaxTurns,
  setSubagentRoleModel,
  setSubagentRolePeerMessages,
  setSubagentRoleToolPolicy,
  changeSubagentRoleProvider,
}: SubagentsSettingsSectionProps) {
  const subagentProviderOptions = providerOptionsFromSettings(providers, { enabledOnly: true });
  const selectedSubagentsProvider = subagentsUseDefaultModel ? preferences.defaultChatProvider : subagentsProvider;
  const selectedSubagentsModel = subagentsUseDefaultModel ? preferences.defaultChatModel : subagentsModel;
  const subagentModelOptions = modelOptionsWithSelected(
    modelOptionsForProvider(selectedSubagentsProvider, providers),
    selectedSubagentsModel,
  );
  const subagentDefaultModelRef = subagentsUseDefaultModel
    ? null
    : { providerId: subagentsProvider, modelId: subagentsModel.trim() };
  const unchanged = subagentSettingsEqual(
    {
      enabled: subagentsEnabled,
      defaultModelRef: subagentDefaultModelRef,
      roles: subagentRoles,
      maxConcurrentRuns: subagentsMaxConcurrentRuns,
      maxConcurrentRunsPerProvider: subagentsMaxConcurrentRunsPerProvider,
      maxConcurrentRunsPerWorkspaceTarget: subagentsMaxConcurrentRunsPerWorkspaceTarget,
      maxTokens: subagentsMaxTokens,
      heartbeatIntervalSeconds: subagentsHeartbeatIntervalSeconds,
    },
    preferences,
  );

  return (
    <section className="account-settings subagents-settings">
      <form className="subagent-settings-form" onSubmit={(event) => void saveDefaults(event)}>
        <div className="subagent-settings-title-row">
          <h1>Subagents</h1>
          <div className="subagent-settings-actions">
            <button className={`settings-primary subagent-save-button${unchanged ? "" : " dirty"}`} disabled={saving || unchanged}>
              <span>{saving ? "Saving" : "Save agents"}</span>
            </button>
            <label className="provider-toggle subagent-card-toggle" aria-label="Allow subagents">
              <input
                type="checkbox"
                checked={subagentsEnabled}
                disabled={saving}
                onChange={(event) => setSubagentsEnabled(event.target.checked)}
              />
              <span />
            </label>
          </div>
        </div>
        <section className="subagent-settings-section">
          <div className="subagent-settings-card-header">
            <div>
              <span>Default model</span>
            </div>
          </div>
          <div className="subagent-field-grid two">
            <label className="settings-select-field">
              <span>Provider</span>
              <select
                value={selectedSubagentsProvider}
                disabled={saving || !subagentsEnabled}
                onChange={(event) => {
                  setSubagentsUseDefaultModel(false);
                  changeSubagentsProvider(event.target.value as ChatProvider);
                }}
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
              <select
                value={selectedSubagentsModel}
                disabled={saving || !subagentsEnabled}
                onChange={(event) => {
                  setSubagentsUseDefaultModel(false);
                  setSubagentsModel(event.target.value);
                }}
              >
                {subagentModelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <div className="subagent-role-list">
          {subagentRoles.map((role) => {
            const preset = SUBAGENT_ROLE_PRESETS.find((candidate) => candidate.id === role.id);
            const roleProvider = role.modelRef?.providerId ?? selectedSubagentsProvider;
            const roleModel =
              role.modelRef?.modelId ||
              defaultModelForProvider(roleProvider, providers) ||
              selectedSubagentsModel;
            const roleModelOptions = combinedModelOptions(subagentProviderOptions, providers, {
              providerId: roleProvider,
              modelId: roleModel,
            });
            const selectedRoleModelValue = modelSelectionValue(roleProvider, roleModel);
            const roleDisabled = saving || !subagentsEnabled || !role.enabled;
            return (
              <section className={`subagent-role-row${role.enabled ? "" : " disabled"}`} key={role.id}>
                <div className="subagent-settings-card-header subagent-role-header">
                  <div className="subagent-role-title">
                    <span>{preset?.label ?? role.id}</span>
                    <small>{preset?.description ?? "Custom subagent role."}</small>
                  </div>
                  <label className="provider-toggle subagent-card-toggle" aria-label={`${preset?.label ?? role.id} enabled`}>
                    <input
                      type="checkbox"
                      checked={role.enabled}
                      disabled={saving || !subagentsEnabled}
                      onChange={(event) => setSubagentRoleEnabled(role.id, event.target.checked)}
                    />
                    <span />
                  </label>
                </div>
                <div className="subagent-role-controls">
                  <label className="settings-select-field">
                    <span>Model</span>
                    <select
                      value={selectedRoleModelValue}
                      disabled={roleDisabled}
                      onChange={(event) => {
                        const option = roleModelOptions.find((candidate) => candidate.value === event.target.value);
                        if (!option) return;
                        changeSubagentRoleProvider(role.id, option.providerId);
                        setSubagentRoleModel(role.id, option.modelId);
                      }}
                    >
                      {roleModelOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
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
                </div>
                <div className="subagent-role-budget-grid">
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

        <section className="subagent-settings-section">
          <div className="subagent-settings-card-header">
            <div>
              <span>Limits</span>
            </div>
          </div>
          <div className="subagent-field-grid four">
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
            <label className="settings-select-field">
              <span>Heartbeat seconds</span>
              <input
                type="number"
                min={10}
                max={3600}
                value={subagentsHeartbeatIntervalSeconds}
                disabled={saving || !subagentsEnabled}
                onChange={(event) => setSubagentsHeartbeatIntervalSeconds(numberOrDefault(event.target.value, 60))}
              />
            </label>
          </div>
        </section>
      </form>
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

type ModelSelectionOption = DropdownOption & {
  providerId: ChatProvider;
  modelId: string;
};

function modelOptionsWithSelected(options: DropdownOption[], selectedModel: string): DropdownOption[] {
  const selected = selectedModel.trim();
  if (!selected || options.some((option) => option.value === selected)) return options;
  return [{ value: selected, label: selected }, ...options];
}

function modelSelectionValue(providerId: ChatProvider, modelId: string): string {
  return JSON.stringify([providerId, modelId]);
}

function combinedModelOptions(
  providerOptions: Array<DropdownOption & { value: ChatProvider }>,
  providers: ProviderSettings | null,
  selected: { providerId: ChatProvider; modelId: string },
): ModelSelectionOption[] {
  const options: ModelSelectionOption[] = [];
  for (const providerOption of providerOptions) {
    const modelOptions = modelOptionsWithSelected(
      modelOptionsForProvider(providerOption.value, providers),
      providerOption.value === selected.providerId ? selected.modelId : "",
    );
    for (const modelOption of modelOptions) {
      options.push({
        value: modelSelectionValue(providerOption.value, modelOption.value),
        label: `${providerOption.label} / ${modelOption.label}`,
        providerId: providerOption.value,
        modelId: modelOption.value,
      });
    }
  }
  if (selected.modelId && !options.some((option) => option.value === modelSelectionValue(selected.providerId, selected.modelId))) {
    options.unshift({
      value: modelSelectionValue(selected.providerId, selected.modelId),
      label: `${chatProviderLabel(selected.providerId, providers)} / ${selected.modelId}`,
      providerId: selected.providerId,
      modelId: selected.modelId,
    });
  }
  return options;
}

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
    defaultModelRef: BootstrapPayload["preferences"]["subagents"]["defaultModelRef"];
    roles: SubagentRoleSettings[];
    maxConcurrentRuns: number;
    maxConcurrentRunsPerProvider: number | null;
    maxConcurrentRunsPerWorkspaceTarget: number | null;
    maxTokens: number | null;
    heartbeatIntervalSeconds: number;
  },
  preferences: BootstrapPayload["preferences"],
): boolean {
  const saved = preferences.subagents;
  return (
    current.enabled === saved.enabled &&
    modelRefsEqual(current.defaultModelRef, saved.defaultModelRef) &&
    current.maxConcurrentRuns === saved.maxConcurrentRuns &&
    current.maxConcurrentRunsPerProvider === saved.maxConcurrentRunsPerProvider &&
    current.maxConcurrentRunsPerWorkspaceTarget === saved.maxConcurrentRunsPerWorkspaceTarget &&
    current.maxTokens === saved.maxTokens &&
    current.heartbeatIntervalSeconds === saved.heartbeatIntervalSeconds &&
    JSON.stringify(current.roles) === JSON.stringify(saved.roles)
  );
}

function modelRefsEqual(
  left: BootstrapPayload["preferences"]["subagents"]["defaultModelRef"],
  right: BootstrapPayload["preferences"]["subagents"]["defaultModelRef"],
): boolean {
  return (left?.providerId ?? null) === (right?.providerId ?? null) && (left?.modelId ?? null) === (right?.modelId ?? null);
}
