import { useSyncExternalStore } from "react";

export type AppearancePreference = "light" | "dark" | "system";

export function subscribeToTheme(listener: () => void): () => void {
  window.addEventListener("openpond:theme-changed", listener);
  return () => window.removeEventListener("openpond:theme-changed", listener);
}

export function getResolvedTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function getPreference(): AppearancePreference {
  const value = document.documentElement.dataset.themePreference;
  return value === "dark" || value === "light" ? value : "system";
}

export function useAppearancePreference(): AppearancePreference {
  return useSyncExternalStore(subscribeToTheme, getPreference, () => "system");
}

export function setAppearancePreference(value: AppearancePreference): void {
  localStorage.setItem("openpond:appearance", value);
  window.dispatchEvent(new CustomEvent("openpond:appearance", { detail: value }));
}
