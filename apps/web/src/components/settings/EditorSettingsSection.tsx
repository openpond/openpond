import type { Dispatch, FormEvent, SetStateAction } from "react";
import type {
  AppPreferences,
  WorkspaceEditorPreferences,
  WorkspaceLspLanguageId,
  WorkspaceLspLanguageMode,
  WorkspaceLspSettingsStatus,
  WorkspaceLspSettingsStatusResponse,
} from "@openpond/contracts";
import { RefreshCw, RotateCw } from "../icons";
import { DropdownSelect } from "../DropdownSelect";
import { LSP_GLOBAL_MODE_OPTIONS, LSP_LANGUAGE_MODE_OPTIONS } from "../../lib/app-models";

type EditorSettingsSectionProps = {
  editorPreferences: WorkspaceEditorPreferences;
  lspStatus: WorkspaceLspSettingsStatusResponse | null;
  preferences: AppPreferences;
  restarting: boolean;
  saving: boolean;
  statusLoading: boolean;
  refreshLspStatus: () => Promise<void>;
  restartLanguageServers: () => Promise<void>;
  saveEditorSettings: (event: FormEvent<HTMLFormElement>) => void;
  setEditorPreferences: Dispatch<SetStateAction<WorkspaceEditorPreferences>>;
  setLanguageCustomCommand: (language: WorkspaceLspLanguageId, customCommand: string) => void;
  setLanguageMode: (language: WorkspaceLspLanguageId, mode: WorkspaceLspLanguageMode) => void;
};

const LANGUAGE_ROWS: Array<{ id: WorkspaceLspLanguageId; label: string; placeholder: string }> = [
  { id: "typescript", label: "TypeScript", placeholder: "typescript-language-server" },
  { id: "python", label: "Python", placeholder: "pyright-langserver" },
  { id: "rust", label: "Rust", placeholder: "rust-analyzer" },
];

export function EditorSettingsSection({
  editorPreferences,
  lspStatus,
  preferences,
  restarting,
  saving,
  statusLoading,
  refreshLspStatus,
  restartLanguageServers,
  saveEditorSettings,
  setEditorPreferences,
  setLanguageCustomCommand,
  setLanguageMode,
}: EditorSettingsSectionProps) {
  const dirty = JSON.stringify(editorPreferences) !== JSON.stringify(preferences.editor);
  const statusByLanguage = new Map(lspStatus?.languages.map((status) => [status.language, status]) ?? []);

  return (
    <section className="account-settings">
      <h1>Editor</h1>
      <form className="provider-settings-form editor-settings-form" onSubmit={(event) => void saveEditorSettings(event)}>
        <div className="account-list-heading">
          <span>Language servers</span>
          <small>Local tools</small>
        </div>
        <div className="provider-settings-grid single">
          <div className="settings-select-field">
            <span>Language servers</span>
            <DropdownSelect
              value={editorPreferences.languageServers}
              disabled={saving}
              label="Language servers"
              options={LSP_GLOBAL_MODE_OPTIONS}
              onChange={(value) =>
                setEditorPreferences((current) => ({
                  ...current,
                  languageServers: value as WorkspaceEditorPreferences["languageServers"],
                }))
              }
            />
          </div>
        </div>
        <label className="settings-check-row">
          <input
            type="checkbox"
            checked={editorPreferences.diagnosticsWhileEditing}
            disabled={saving || editorPreferences.languageServers === "off"}
            onChange={(event) =>
              setEditorPreferences((current) => ({
                ...current,
                diagnosticsWhileEditing: event.target.checked,
              }))
            }
          />
          <span>
            <strong>Diagnostics while editing</strong>
            <small>Update Monaco markers as the local buffer changes.</small>
          </span>
        </label>
        <label className="settings-check-row">
          <input
            type="checkbox"
            checked={editorPreferences.checkOnSave}
            disabled={saving || editorPreferences.languageServers === "off"}
            onChange={(event) =>
              setEditorPreferences((current) => ({
                ...current,
                checkOnSave: event.target.checked,
              }))
            }
          />
          <span>
            <strong>Check on save</strong>
            <small>Refresh diagnostics after writing a file.</small>
          </span>
        </label>

        <div className="account-list-heading">
          <span>Languages</span>
          <small>Auto, disabled, or custom executable</small>
        </div>
        <div className="lsp-language-list">
          {LANGUAGE_ROWS.map((language) => {
            const languagePreference = editorPreferences.languages[language.id];
            return (
              <div className="lsp-language-row" key={language.id}>
                <div className="lsp-language-label">
                  <strong>{language.label}</strong>
                  <span>{statusLabel(statusByLanguage.get(language.id), statusLoading)}</span>
                </div>
                <div className="settings-select-field">
                  <span>Mode</span>
                  <DropdownSelect
                    value={languagePreference.mode}
                    disabled={saving || editorPreferences.languageServers === "off"}
                    label={`${language.label} language server mode`}
                    options={LSP_LANGUAGE_MODE_OPTIONS}
                    onChange={(value) => setLanguageMode(language.id, value as WorkspaceLspLanguageMode)}
                  />
                </div>
                <label className="settings-select-field">
                  <span>Custom executable</span>
                  <input
                    value={languagePreference.customCommand}
                    disabled={saving || editorPreferences.languageServers === "off" || languagePreference.mode !== "custom"}
                    placeholder={language.placeholder}
                    onChange={(event) => setLanguageCustomCommand(language.id, event.target.value)}
                  />
                </label>
              </div>
            );
          })}
        </div>

        <button className="settings-primary" disabled={saving || !dirty}>
          <span>{saving ? "Saving" : "Save editor settings"}</span>
        </button>
      </form>

      <div className="account-list">
        <div className="account-list-heading">
          <span>LSP status</span>
          <div className="settings-heading-actions">
            <small>{statusLoading ? "Checking" : lspStatus ? "Current" : "Not checked"}</small>
            <button
              type="button"
              className="settings-icon-button"
              title="Refresh LSP status"
              aria-label="Refresh LSP status"
              disabled={statusLoading || restarting}
              onClick={() => void refreshLspStatus()}
            >
              <RefreshCw className={statusLoading ? "settings-spin" : undefined} size={15} />
            </button>
            <button
              type="button"
              className="settings-secondary"
              disabled={statusLoading || restarting}
              onClick={() => void restartLanguageServers()}
            >
              <RotateCw className={restarting ? "settings-spin" : undefined} size={15} />
              <span>{restarting ? "Restarting" : "Restart"}</span>
            </button>
          </div>
        </div>
        {LANGUAGE_ROWS.map((language) => {
          const status = statusByLanguage.get(language.id);
          return (
            <div className="product-row lsp-status-row" key={language.id}>
              <div>
                <strong>{language.label}</strong>
                <span title={status?.command ?? status?.message ?? undefined}>
                  {status?.command ?? status?.message ?? "Not checked"}
                </span>
              </div>
              <span className={`lsp-status-pill ${status?.status ?? "missing"}`}>
                {statusLabel(status, statusLoading)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="settings-footnote">
        <span>Project config</span>
        <strong>Uses tsconfig, pyrightconfig, pyproject, and Cargo files when present</strong>
      </div>
    </section>
  );
}

function statusLabel(status: WorkspaceLspSettingsStatus | undefined, loading: boolean): string {
  if (loading && !status) return "Checking";
  if (!status) return "Not checked";
  if (status.status === "found") return "Found";
  if (status.status === "disabled") return "Disabled";
  if (status.status === "error") return "Error";
  return "Missing";
}
