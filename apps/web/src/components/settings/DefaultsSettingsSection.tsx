import type { FormEvent } from "react";
import type { BootstrapPayload } from "@openpond/contracts";
import { FolderOpen } from "../icons";
import { normalizeBranchPrefix } from "../../lib/app-models";

type DefaultsSettingsSectionProps = {
  advancedWorkspaceControls: boolean;
  defaultBranchPrefix: string;
  defaultNewProjectDirectory: string;
  preferences: BootstrapPayload["preferences"];
  saving: boolean;
  chooseDefaultProjectDirectory: () => void | Promise<void>;
  saveDefaults: (event: FormEvent<HTMLFormElement>) => void;
  setAdvancedWorkspaceControls: (value: boolean) => void;
  setDefaultBranchPrefix: (value: string) => void;
  setDefaultNewProjectDirectory: (value: string) => void;
};

export function DefaultsSettingsSection({
  advancedWorkspaceControls,
  defaultBranchPrefix,
  defaultNewProjectDirectory,
  preferences,
  saving,
  chooseDefaultProjectDirectory,
  saveDefaults,
  setAdvancedWorkspaceControls,
  setDefaultBranchPrefix,
  setDefaultNewProjectDirectory,
}: DefaultsSettingsSectionProps) {
  const unchanged =
    normalizeBranchPrefix(defaultBranchPrefix) === preferences.defaultBranchPrefix &&
    defaultNewProjectDirectory.trim() === preferences.defaultNewProjectDirectory &&
    advancedWorkspaceControls === preferences.advancedWorkspaceControls;

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
        <button className="settings-primary" disabled={saving || unchanged}>
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
    </section>
  );
}
