import { z } from "zod";
import { AppPreferencesSchema, DEFAULT_CODEX_CHAT_MODEL, DEFAULT_CODEX_REASONING_EFFORT } from "./schemas/settings.js";
import { PersistenceError } from "./errors.js";
import { expandHome } from "./home.js";

function conflict(file: string, message: string): never {
  throw new PersistenceError({ code: "MIGRATION_CONFLICT", path: file, message, action: "Resolve this source field and restart failed migration preparation. Its original backup is retained." });
}
export function assertNoUnmappedFields(raw: unknown, normalized: unknown, file: string, segments: string[] = []): void {
  if (!raw || typeof raw !== "object" || !normalized || typeof normalized !== "object") return;
  if (Array.isArray(raw) && Array.isArray(normalized)) {
    raw.forEach((value, index) => assertNoUnmappedFields(value, normalized[index], file, [...segments, String(index)])); return;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(normalized, key)) conflict(file, `Unmapped stored field: ${[...segments, key].join(".")}`);
    assertNoUnmappedFields(value, (normalized as Record<string, unknown>)[key], file, [...segments, key]);
  }
}
const oldSession = z.strictObject({ token: z.string().optional(), appId: z.string().nullable().optional(), conversationId: z.string().nullable().optional() });
const oldAccount = z.strictObject({ handle: z.string().min(1), baseUrl: z.string().optional(), apiBaseUrl: z.string().optional(), chatApiBaseUrl: z.string().optional(), environment: z.string().optional(), apiKey: z.string().optional(), session: oldSession.optional() });
export function validateImportedAccounts(raw: Record<string, unknown>, file: string): void {
  if (raw.accounts !== undefined) {
    const parsed = z.array(oldAccount).safeParse(raw.accounts);
    if (!parsed.success) conflict(file, `Invalid stored accounts: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }
  if (raw.activeProfile !== undefined && !z.strictObject({ handle: z.string().min(1), baseUrl: z.string().nullable().optional() }).safeParse(raw.activeProfile).success) conflict(file, "Invalid stored active account selector.");
}
export function normalizeImportedPreferences(value: unknown, file: string) {
  const original = AppPreferencesSchema.parse(value);
  assertNoUnmappedFields(value, original, file);
  const migrated = migrateSubagentDefaults(value);
  const preferences = AppPreferencesSchema.parse(migrated);
  const legacyCodex = preferences.defaultChatProvider === "codex" && ["codex-default", "gpt-5.5"].includes(preferences.defaultChatModel);
  return {
    ...preferences,
    defaultTeamId: preferences.defaultTeamId?.trim() || null,
    defaultNewProjectDirectory: expandHome(preferences.defaultNewProjectDirectory.trim()),
    ...(legacyCodex ? { defaultChatModel: DEFAULT_CODEX_CHAT_MODEL } : {}),
    ...(legacyCodex && preferences.codexReasoningEffort === "medium" ? { codexReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT } : {}),
  };
}
function migrateSubagentDefaults(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const preferences = value as Record<string, unknown>;
  const subagents = preferences.subagents;
  if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return value;
  const old = subagents as Record<string, unknown>;
  const workspaceCurrent = old.workspaceDefaultsVersion === 1, toolsCurrent = old.toolDefaultsVersion === 1;
  if (workspaceCurrent && toolsCurrent) return value;
  const roles = Array.isArray(old.roles) ? old.roles.map((role: Record<string, unknown>) => ({ ...role,
    ...(!workspaceCurrent && role.isolationMode === "copy_on_write" ? { isolationMode: "none" } : {}),
    ...(!toolsCurrent ? { toolPolicy: "full_tools" } : {}),
  })) : old.roles;
  return { ...preferences, subagents: { ...old, workspaceDefaultsVersion: 1, toolDefaultsVersion: 1,
    maxConcurrentRunsPerWorkspaceTarget: !workspaceCurrent && old.maxConcurrentRunsPerWorkspaceTarget === 2 ? 1 : old.maxConcurrentRunsPerWorkspaceTarget,
    ...(roles === undefined ? {} : { roles }),
  } };
}
