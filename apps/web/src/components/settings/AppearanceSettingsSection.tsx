import { useState } from "react";
import { DropdownSelect } from "../DropdownSelect";
import { setAppearancePreference, useAppearancePreference } from "../../theme/appearance";

const options = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function AppearanceSettingsSection() {
  const preference = useAppearancePreference();
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="account-settings">
      <h1>Appearance</h1>
      <div className="provider-settings-form">
        <div className="provider-settings-grid single">
          <div className="settings-select-field">
            <span>Color theme</span>
            <DropdownSelect
              label="Color theme"
              value={preference}
              options={options}
              onChange={(value) => {
                if (value !== "dark" && value !== "light" && value !== "system") return;
                try {
                  setAppearancePreference(value);
                  setError(null);
                } catch {
                  setError("This browser could not save your appearance preference.");
                }
              }}
            />
            <small>System follows your device’s appearance. Your choice is saved on this device.</small>
            {error && <p role="alert">{error}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
