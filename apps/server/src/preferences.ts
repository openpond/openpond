import {
  AppPreferencesSchema,
  DEFAULT_CODEX_CHAT_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
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
  const migrated = migrateSubagentWorkspaceDefaults(value);
  const parsed = AppPreferencesSchema.safeParse(migrated ?? {});
  const preferences = parsed.success ? parsed.data : AppPreferencesSchema.parse({});
  const defaultTeamId = preferences.defaultTeamId?.trim() || null;
  const legacyCodexDefaultModel =
    preferences.defaultChatProvider === "codex" &&
    (preferences.defaultChatModel === "codex-default" || preferences.defaultChatModel === "gpt-5.5");
  return {
    ...preferences,
    defaultTeamId,
    ...(legacyCodexDefaultModel ? { defaultChatModel: DEFAULT_CODEX_CHAT_MODEL } : {}),
    ...(legacyCodexDefaultModel && preferences.codexReasoningEffort === "medium"
      ? { codexReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT }
      : {}),
    defaultNewProjectDirectory: normalizeProjectDirectory(preferences.defaultNewProjectDirectory),
  };
}

function migrateSubagentWorkspaceDefaults(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const preferences = value as Record<string, unknown>;
  const subagents = preferences.subagents;
  if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return value;
  const subagentPreferences = subagents as Record<string, unknown>;
  if (subagentPreferences.workspaceDefaultsVersion === 1) return value;
  const roles = Array.isArray(subagentPreferences.roles)
    ? subagentPreferences.roles.map((role) => {
        if (!role || typeof role !== "object" || Array.isArray(role)) return role;
        const roleRecord = role as Record<string, unknown>;
        return roleRecord.isolationMode === "copy_on_write"
          ? { ...roleRecord, isolationMode: "none" }
          : role;
      })
    : subagentPreferences.roles;
  return {
    ...preferences,
    subagents: {
      ...subagentPreferences,
      workspaceDefaultsVersion: 1,
      maxConcurrentRunsPerWorkspaceTarget:
        subagentPreferences.maxConcurrentRunsPerWorkspaceTarget === 2
          ? 1
          : subagentPreferences.maxConcurrentRunsPerWorkspaceTarget,
      ...(roles === undefined ? {} : { roles }),
    },
  };
}
