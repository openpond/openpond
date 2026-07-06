import type { AppPreferences, OpenPondCommandAccessMode } from "@openpond/contracts";
import { DEFAULT_OPENPOND_COMMAND_ACCESS_MODE } from "@openpond/contracts";
import { normalizePreferences } from "./app-models";

export const OPENPOND_COMMAND_ACCESS_MODE_STORAGE_KEY = "openpond.commandAccessMode";

export type OpenPondCommandAccessPreferences = Pick<AppPreferences, "openPondCommandAccessMode">;
type CommandAccessPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function browserLocalStorage(): CommandAccessPreferenceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseOpenPondCommandAccessMode(value: string | null): OpenPondCommandAccessMode | null {
  if (value === "ask" || value === "full-access" || value === "disabled") return value;
  return null;
}

export function readStoredOpenPondCommandAccessPreferences(
  storage: CommandAccessPreferenceStorage | null = browserLocalStorage(),
): Partial<OpenPondCommandAccessPreferences> {
  if (!storage) return {};
  const openPondCommandAccessMode = parseOpenPondCommandAccessMode(
    storage.getItem(OPENPOND_COMMAND_ACCESS_MODE_STORAGE_KEY),
  );
  return {
    ...(openPondCommandAccessMode ? { openPondCommandAccessMode } : {}),
  };
}

export function writeStoredOpenPondCommandAccessMode(
  mode: OpenPondCommandAccessMode,
  storage: CommandAccessPreferenceStorage | null = browserLocalStorage(),
): void {
  try {
    storage?.setItem(OPENPOND_COMMAND_ACCESS_MODE_STORAGE_KEY, mode);
  } catch {
    // Local persistence is a convenience layer; server preferences still handle the durable save.
  }
}

export function openPondCommandAccessPreferencesWithLocalOverride(
  preferences?: AppPreferences | null,
  storage: CommandAccessPreferenceStorage | null = browserLocalStorage(),
): OpenPondCommandAccessPreferences {
  const normalized = normalizePreferences(preferences);
  const stored = readStoredOpenPondCommandAccessPreferences(storage);
  return {
    openPondCommandAccessMode:
      stored.openPondCommandAccessMode ??
      normalized.openPondCommandAccessMode ??
      DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
  };
}

export function storedOpenPondCommandAccessPreferenceSyncPatch(
  preferences?: AppPreferences | null,
  storage: CommandAccessPreferenceStorage | null = browserLocalStorage(),
): Partial<OpenPondCommandAccessPreferences> {
  const normalized = normalizePreferences(preferences);
  const stored = readStoredOpenPondCommandAccessPreferences(storage);
  const patch: Partial<OpenPondCommandAccessPreferences> = {};
  if (
    stored.openPondCommandAccessMode &&
    stored.openPondCommandAccessMode !== normalized.openPondCommandAccessMode
  ) {
    patch.openPondCommandAccessMode = stored.openPondCommandAccessMode;
  }
  return patch;
}
