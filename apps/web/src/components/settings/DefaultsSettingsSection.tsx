import type { FormEvent } from "react";
import type { BootstrapPayload } from "@openpond/contracts";
import { FolderOpen } from "../icons";
import { normalizeBranchPrefix } from "../../lib/app-models";

type DefaultsSettingsSectionProps = {
  advancedWorkspaceControls: boolean;
  defaultBranchPrefix: string;
  defaultNewProjectDirectory: string;
  goalStorageLocation: BootstrapPayload["preferences"]["goalStorageLocation"];
  preferences: BootstrapPayload["preferences"];
  saving: boolean;
  chooseDefaultProjectDirectory: () => void | Promise<void>;
  saveDefaults: (event: FormEvent<HTMLFormElement>) => void;
  setAdvancedWorkspaceControls: (value: boolean) => void;
  setDefaultBranchPrefix: (value: string) => void;
  setDefaultNewProjectDirectory: (value: string) => void;
  setGoalStorageLocation: (value: BootstrapPayload["preferences"]["goalStorageLocation"]) => void;
};

export function DefaultsSettingsSection({
  advancedWorkspaceControls,
  defaultBranchPrefix,
  defaultNewProjectDirectory,
  goalStorageLocation,
  preferences,
  saving,
  chooseDefaultProjectDirectory,
  saveDefaults,
  setAdvancedWorkspaceControls,
  setDefaultBranchPrefix,
  setDefaultNewProjectDirectory,
  setGoalStorageLocation,
}: DefaultsSettingsSectionProps) {
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
        <button
          className="settings-primary"
          disabled={
            saving ||
            (normalizeBranchPrefix(defaultBranchPrefix) === preferences.defaultBranchPrefix &&
              defaultNewProjectDirectory.trim() === preferences.defaultNewProjectDirectory &&
              goalStorageLocation === preferences.goalStorageLocation &&
              advancedWorkspaceControls === preferences.advancedWorkspaceControls)
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
    </section>
  );
}
