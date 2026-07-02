import {
  AppPreferencesSchema,
  DEFAULT_CODEX_CHAT_MODEL,
  type AppPreferences,
  type SidebarAppPreference,
} from "@openpond/contracts";
import { normalizeProjectDirectory } from "./workspace/project-directories.js";

export function normalizeSidebarAppPreference(preference: SidebarAppPreference): SidebarAppPreference {
  const pinned = Boolean(preference.pinned);
  const archived = pinned ? false : Boolean(preference.archived);
  const order = typeof preference.order === "number" && Number.isFinite(preference.order) ? preference.order : undefined;
  return {
    pinned,
    archived,
    ...(order === undefined ? {} : { order }),
  };
}

export function normalizeAppPreferences(value: unknown): AppPreferences {
  const parsed = AppPreferencesSchema.safeParse(value ?? {});
  const preferences = parsed.success ? parsed.data : AppPreferencesSchema.parse({});
  const defaultTeamId = preferences.defaultTeamId?.trim() || null;
  if (preferences.defaultChatProvider === "codex" && preferences.defaultChatModel === "codex-default") {
    return {
      ...preferences,
      defaultTeamId,
      defaultChatModel: DEFAULT_CODEX_CHAT_MODEL,
      defaultNewProjectDirectory: normalizeProjectDirectory(preferences.defaultNewProjectDirectory),
    };
  }
  return {
    ...preferences,
    defaultTeamId,
    defaultNewProjectDirectory: normalizeProjectDirectory(preferences.defaultNewProjectDirectory),
  };
}
