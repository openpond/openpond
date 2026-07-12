import type { AppPreferences, ProviderSettings } from "@openpond/contracts";
import type { ClientConnection, PreferencesPayload } from "../../api";
import { TrainingSettingsSection } from "../settings/TrainingSettingsSection";
import { X } from "../icons";
import "../../styles/settings/settings-forms.css";
import "../../styles/settings/settings-lists.css";

export function TrainingSettingsDialog({
  connection,
  onClose,
  onError,
  onPreferences,
  preferences,
  providers,
}: {
  connection: ClientConnection | null;
  onClose: () => void;
  onError: (message: string | null) => void;
  onPreferences: (payload: PreferencesPayload) => void;
  preferences: AppPreferences;
  providers: ProviderSettings | null;
}) {
  return (
    <div className="training-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label="Training settings"
        aria-modal="true"
        className="training-dialog training-settings-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="training-dialog-header">
          <div><h2>Training settings</h2></div>
          <button type="button" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="training-settings-dialog-body">
          <TrainingSettingsSection
            connection={connection}
            embedded
            onError={onError}
            onPreferences={onPreferences}
            preferences={preferences}
            providers={providers}
          />
        </div>
      </section>
    </div>
  );
}
