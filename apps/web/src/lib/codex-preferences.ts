import type { AppPreferences, CodexPermissionMode, CodexReasoningEffort } from "@openpond/contracts";
import { DEFAULT_CODEX_PERMISSION_MODE, DEFAULT_CODEX_REASONING_EFFORT } from "@openpond/contracts";
import { normalizePreferences } from "./app-models";

export const CODEX_PERMISSION_MODE_STORAGE_KEY = "openpond.codexPermissionMode";
export const CODEX_REASONING_EFFORT_STORAGE_KEY = "openpond.codexReasoningEffort";

export type CodexChatPreferences = Pick<AppPreferences, "codexPermissionMode" | "codexReasoningEffort">;
type CodexPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function browserLocalStorage(): CodexPreferenceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseCodexPermissionMode(value: string | null): CodexPermissionMode | null {
  if (value === "default" || value === "auto-review" || value === "full-access") return value;
  return null;
}

function parseCodexReasoningEffort(value: string | null): CodexReasoningEffort | null {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  return null;
}

export function readStoredCodexChatPreferences(
  storage: CodexPreferenceStorage | null = browserLocalStorage(),
): Partial<CodexChatPreferences> {
  if (!storage) return {};
  const codexPermissionMode = parseCodexPermissionMode(storage.getItem(CODEX_PERMISSION_MODE_STORAGE_KEY));
  const codexReasoningEffort = parseCodexReasoningEffort(storage.getItem(CODEX_REASONING_EFFORT_STORAGE_KEY));
  return {
    ...(codexPermissionMode ? { codexPermissionMode } : {}),
    ...(codexReasoningEffort ? { codexReasoningEffort } : {}),
  };
}

export function writeStoredCodexPermissionMode(
  mode: CodexPermissionMode,
  storage: CodexPreferenceStorage | null = browserLocalStorage(),
): void {
  try {
    storage?.setItem(CODEX_PERMISSION_MODE_STORAGE_KEY, mode);
  } catch {
    // Local persistence is a convenience layer; server preferences still handle the durable save.
  }
}

export function writeStoredCodexReasoningEffort(
  effort: CodexReasoningEffort,
  storage: CodexPreferenceStorage | null = browserLocalStorage(),
): void {
  try {
    storage?.setItem(CODEX_REASONING_EFFORT_STORAGE_KEY, effort);
  } catch {
    // Local persistence is a convenience layer; server preferences still handle the durable save.
  }
}

export function codexPreferencesWithLocalOverrides(
  preferences?: AppPreferences | null,
  storage: CodexPreferenceStorage | null = browserLocalStorage(),
): CodexChatPreferences {
  const normalized = normalizePreferences(preferences);
  const stored = readStoredCodexChatPreferences(storage);
  return {
    codexPermissionMode:
      stored.codexPermissionMode ?? normalized.codexPermissionMode ?? DEFAULT_CODEX_PERMISSION_MODE,
    codexReasoningEffort:
      stored.codexReasoningEffort ?? normalized.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
  };
}

export function storedCodexPreferenceSyncPatch(
  preferences?: AppPreferences | null,
  storage: CodexPreferenceStorage | null = browserLocalStorage(),
): Partial<CodexChatPreferences> {
  const normalized = normalizePreferences(preferences);
  const stored = readStoredCodexChatPreferences(storage);
  const patch: Partial<CodexChatPreferences> = {};
  if (stored.codexPermissionMode && stored.codexPermissionMode !== normalized.codexPermissionMode) {
    patch.codexPermissionMode = stored.codexPermissionMode;
  }
  if (stored.codexReasoningEffort && stored.codexReasoningEffort !== normalized.codexReasoningEffort) {
    patch.codexReasoningEffort = stored.codexReasoningEffort;
  }
  return patch;
}
