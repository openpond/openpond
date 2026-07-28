import type { FormEvent } from "react";
import type {
  BootstrapPayload,
  ChatProvider,
  ProviderSettings,
  SubagentIsolationMode,
  SubagentDelegationMode,
  SubagentPeerMessages,
  SubagentRoleSettings,
  SubagentToolPolicy,
} from "@openpond/contracts";
import { SUBAGENT_ROLE_PRESETS } from "@openpond/contracts";
import {
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

type ContextSettingsSectionProps = SharedHarnessSettingsProps & {
  contextCompactionAutoEnabled: boolean;
  setContextCompactionAutoEnabled: (value: boolean) => void;
};

type SubagentsSettingsSectionProps = SharedHarnessSettingsProps & {
  subagentsEnabled: boolean;
  subagentDelegationMode: SubagentDelegationMode;
  subagentsUseDefaultModel: boolean;
  subagentsProvider: ChatProvider;
  subagentsModel: string;
  subagentRoles: SubagentRoleSettings[];
  subagentsMaxConcurrentRuns: number;
  subagentsMaxConcurrentRunsPerProvider: number | null;
  subagentsMaxConcurrentRunsPerWorkspaceTarget: number | null;
  providers: ProviderSettings | null;
  changeSubagentsProvider: (provider: ChatProvider) => void;
  setSubagentsEnabled: (value: boolean) => void;
  setSubagentDelegationMode: (value: SubagentDelegationMode) => void;
  setSubagentsUseDefaultModel: (value: boolean) => void;
  setSubagentsModel: (value: string) => void;
  setSubagentsMaxConcurrentRuns: (value: number) => void;
  setSubagentsMaxConcurrentRunsPerProvider: (value: number | null) => void;
  setSubagentsMaxConcurrentRunsPerWorkspaceTarget: (value: number | null) => void;
  setSubagentRoleEnabled: (roleId: string, enabled: boolean) => void;
  setSubagentRoleIsolationMode: (roleId: string, isolationMode: SubagentIsolationMode) => void;
  setSubagentRoleMaxConcurrentRuns: (roleId: string, value: number) => void;
  setSubagentRoleModel: (roleId: string, model: string) => void;
  setSubagentRolePeerMessages: (roleId: string, peerMessages: SubagentPeerMessages) => void;
  setSubagentRoleToolPolicy: (roleId: string, toolPolicy: SubagentToolPolicy) => void;
  changeSubagentRoleProvider: (roleId: string, provider: ChatProvider) => void;
};

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

export function SubagentsSettingsSection({
  subagentsEnabled,
  subagentDelegationMode,
  subagentsUseDefaultModel,
  subagentsProvider,
  subagentsModel,
  subagentRoles,
  subagentsMaxConcurrentRuns,
  subagentsMaxConcurrentRunsPerProvider,
  subagentsMaxConcurrentRunsPerWorkspaceTarget,
  preferences,
  providers,
  saving,
  saveDefaults,
  changeSubagentsProvider,
  setSubagentsEnabled,
  setSubagentDelegationMode,
  setSubagentsUseDefaultModel,
  setSubagentsModel,
  setSubagentsMaxConcurrentRuns,
  setSubagentsMaxConcurrentRunsPerProvider,
  setSubagentsMaxConcurrentRunsPerWorkspaceTarget,
  setSubagentRoleEnabled,
  setSubagentRoleIsolationMode,
  setSubagentRoleMaxConcurrentRuns,
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
      delegationMode: subagentDelegationMode,
      defaultModelRef: subagentDefaultModelRef,
      roles: subagentRoles,
      maxConcurrentRuns: subagentsMaxConcurrentRuns,
      maxConcurrentRunsPerProvider: subagentsMaxConcurrentRunsPerProvider,
      maxConcurrentRunsPerWorkspaceTarget: subagentsMaxConcurrentRunsPerWorkspaceTarget,
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
              <span>Default delegation</span>
              <small>Used unless a task overrides it from the composer.</small>
            </div>
          </div>
          <div className="subagent-field-grid two">
            <label className="settings-select-field">
              <span>Subagent use</span>
              <select
                value={subagentDelegationMode}
                disabled={saving || !subagentsEnabled}
                onChange={(event) => setSubagentDelegationMode(event.target.value as SubagentDelegationMode)}
              >
                <option value="manual">Manual</option>
                <option value="balanced">Balanced</option>
                <option value="proactive">Proactive</option>
              </select>
            </label>
          </div>
        </section>
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
                </div>
              </section>
            );
          })}
        </div>

        <section className="subagent-settings-section">
          <div className="subagent-settings-card-header">
            <div>
              <span>Limits</span>
              <small>Controls child worker concurrency.</small>
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
          </div>
        </section>
      </form>
    </section>
  );
}

const SUBAGENT_ISOLATION_OPTIONS: Array<{ value: SubagentIsolationMode; label: string }> = [
  { value: "none", label: "Direct workspace" },
  { value: "copy_on_write", label: "Copy-on-write" },
  { value: "worktree", label: "Worktree" },
];

const SUBAGENT_TOOL_POLICY_OPTIONS: Array<{ value: SubagentToolPolicy; label: string }> = [
  { value: "read_only", label: "Read only" },
  { value: "workspace_write", label: "Workspace write" },
  { value: "full_tools", label: "Full tools" },
];

const SUBAGENT_PEER_MESSAGE_OPTIONS: Array<{ value: SubagentPeerMessages; label: string }> = [
  { value: "parent_scoped", label: "Parent-scoped handoffs" },
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
    delegationMode: SubagentDelegationMode;
    defaultModelRef: BootstrapPayload["preferences"]["subagents"]["defaultModelRef"];
    roles: SubagentRoleSettings[];
    maxConcurrentRuns: number;
    maxConcurrentRunsPerProvider: number | null;
    maxConcurrentRunsPerWorkspaceTarget: number | null;
  },
  preferences: BootstrapPayload["preferences"],
): boolean {
  const saved = preferences.subagents;
  return (
    current.enabled === saved.enabled &&
    current.delegationMode === saved.delegationMode &&
    modelRefsEqual(current.defaultModelRef, saved.defaultModelRef) &&
    current.maxConcurrentRuns === saved.maxConcurrentRuns &&
    current.maxConcurrentRunsPerProvider === saved.maxConcurrentRunsPerProvider &&
    current.maxConcurrentRunsPerWorkspaceTarget === saved.maxConcurrentRunsPerWorkspaceTarget &&
    JSON.stringify(current.roles) === JSON.stringify(saved.roles)
  );
}

function modelRefsEqual(
  left: BootstrapPayload["preferences"]["subagents"]["defaultModelRef"],
  right: BootstrapPayload["preferences"]["subagents"]["defaultModelRef"],
): boolean {
  return (left?.providerId ?? null) === (right?.providerId ?? null) && (left?.modelId ?? null) === (right?.modelId ?? null);
}
