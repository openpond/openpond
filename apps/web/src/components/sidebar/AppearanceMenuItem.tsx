import { useState, useSyncExternalStore } from "react";
import Moon from "lucide-react/dist/esm/icons/moon.js";
import { useErrorToast } from "../../app/AppToastContext";
import { getResolvedTheme, setAppearancePreference, subscribeToTheme } from "../../theme/appearance";

export function AppearanceMenuItem() {
  const theme = useSyncExternalStore(subscribeToTheme, getResolvedTheme, () => "dark");
  const [error, setError] = useState<string | null>(null);
  useErrorToast(error);
  const light = theme === "light";
  return (
    <button
      type="button"
      className="user-auth-menu-link user-auth-theme-toggle"
      role="menuitemcheckbox"
      aria-label="Dark mode"
      aria-checked={!light}
      title={`Switch to ${light ? "dark" : "light"} mode`}
      onClick={() => {
        try {
          setAppearancePreference(light ? "dark" : "light");
          setError(null);
        } catch {
          setError("Could not save your appearance preference.");
        }
      }}
    >
      <Moon size={15} aria-hidden="true" />
      <span>Dark mode</span>
      <span className="user-auth-theme-switch" aria-hidden="true" />
    </button>
  );
}
