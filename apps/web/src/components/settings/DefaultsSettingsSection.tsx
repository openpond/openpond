import type { FormEvent } from "react";
import type {
  BootstrapPayload,
  ChatProvider,
  InsightsEvidenceSourceSettings,
  ProviderSettings,
} from "@openpond/contracts";
import { FolderOpen } from "../icons";
import {
  chatModelLabel,
  chatProviderLabel,
  modelOptionsForProvider,
  normalizeBranchPrefix,
  providerOptionsFromSettings,
} from "../../lib/app-models";

type DefaultsSettingsSectionProps = {
  advancedWorkspaceControls: boolean;
  defaultBranchPrefix: string;
  defaultNewProjectDirectory: string;
  goalStorageLocation: BootstrapPayload["preferences"]["goalStorageLocation"];
  insightsEnabled: boolean;
  insightsUseDefaultModel: boolean;
  insightsProvider: ChatProvider;
  insightsModel: string;
  insightsEvidenceSources: InsightsEvidenceSourceSettings;
  preferences: BootstrapPayload["preferences"];
  providers: ProviderSettings | null;
  saving: boolean;
  chooseDefaultProjectDirectory: () => void | Promise<void>;
  saveDefaults: (event: FormEvent<HTMLFormElement>) => void;
  changeInsightsProvider: (provider: ChatProvider) => void;
  setAdvancedWorkspaceControls: (value: boolean) => void;
  setDefaultBranchPrefix: (value: string) => void;
  setDefaultNewProjectDirectory: (value: string) => void;
  setGoalStorageLocation: (value: BootstrapPayload["preferences"]["goalStorageLocation"]) => void;
  setInsightsEnabled: (value: boolean) => void;
  setInsightsUseDefaultModel: (value: boolean) => void;
  setInsightsModel: (value: string) => void;
  setInsightsEvidenceSourceEnabled: (key: keyof InsightsEvidenceSourceSettings, enabled: boolean) => void;
};

export function DefaultsSettingsSection({
  advancedWorkspaceControls,
  defaultBranchPrefix,
  defaultNewProjectDirectory,
  goalStorageLocation,
  insightsEnabled,
  insightsUseDefaultModel,
  insightsProvider,
  insightsModel,
  insightsEvidenceSources,
  preferences,
  providers,
  saving,
  chooseDefaultProjectDirectory,
  saveDefaults,
  changeInsightsProvider,
  setAdvancedWorkspaceControls,
  setDefaultBranchPrefix,
  setDefaultNewProjectDirectory,
  setGoalStorageLocation,
  setInsightsEnabled,
  setInsightsUseDefaultModel,
  setInsightsModel,
  setInsightsEvidenceSourceEnabled,
}: DefaultsSettingsSectionProps) {
  const insightProviderOptions = providerOptionsFromSettings(providers, { enabledOnly: true });
  const insightModelOptions = modelOptionsForProvider(insightsProvider, providers);
  const insightModelDatalistId = "settings-insights-model-options";
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
        <button
          className="settings-primary"
          disabled={
            saving ||
            (normalizeBranchPrefix(defaultBranchPrefix) === preferences.defaultBranchPrefix &&
              defaultNewProjectDirectory.trim() === preferences.defaultNewProjectDirectory &&
              goalStorageLocation === preferences.goalStorageLocation &&
              advancedWorkspaceControls === preferences.advancedWorkspaceControls &&
              insightsEnabled === preferences.insightsEnabled &&
              insightEvidenceSourcesEqual(insightsEvidenceSources, preferences.insightsEvidenceSources) &&
              insightModelSettingsEqual({
                useDefault: insightsUseDefaultModel,
                provider: insightsProvider,
                model: insightsModel,
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
    </section>
  );
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
