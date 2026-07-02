import {
  PatchSessionRequestSchema,
  type PatchSessionRequest,
  type Session,
} from "@openpond/contracts";
import { codexHistoryThreadIdFromSessionId } from "./codex-history.js";
import type { SqliteStore } from "./store/store.js";
import { now } from "./utils.js";

const CODEX_HISTORY_SIDEBAR_PREFERENCES_TYPE = "codex_history.sidebar_preferences";

export type CodexHistorySidebarPreference = {
  pinned?: boolean;
  archived?: boolean;
  order?: number;
  title?: string;
  updatedAt?: string;
};

export type CodexHistorySidebarPreferences = Record<string, CodexHistorySidebarPreference>;

export async function loadCodexHistorySidebarPreferences(
  store: SqliteStore,
): Promise<CodexHistorySidebarPreferences> {
  const entries = await store.getCacheEntriesByType<unknown>(CODEX_HISTORY_SIDEBAR_PREFERENCES_TYPE);
  const preferences: CodexHistorySidebarPreferences = {};
  for (const [threadId, entry] of Object.entries(entries)) {
    const preference = normalizePreference(entry.payload);
    if (Object.keys(preference).length > 0) preferences[threadId] = preference;
  }
  return preferences;
}

export async function patchCodexHistorySidebarPreference(
  store: SqliteStore,
  sessionId: string,
  payload: unknown,
): Promise<CodexHistorySidebarPreference> {
  const threadId = codexHistoryThreadIdFromSessionId(sessionId);
  if (!threadId) throw new Error("Codex history session not found");

  const input = PatchSessionRequestSchema.parse(payload);
  const existing = await store.getCacheEntry<unknown>(CODEX_HISTORY_SIDEBAR_PREFERENCES_TYPE, threadId);
  const updated = normalizePreference(mergePreferencePatch(normalizePreference(existing?.payload), input));

  await store.setCacheEntry(
    CODEX_HISTORY_SIDEBAR_PREFERENCES_TYPE,
    threadId,
    updated,
  );

  return updated;
}

export function applyCodexHistorySidebarPreferences(
  sessions: Session[],
  preferences: CodexHistorySidebarPreferences,
): Session[] {
  return sessions.map((session) => applyCodexHistorySidebarPreference(session, preferences));
}

export function applyCodexHistorySidebarPreference(
  session: Session,
  preferences: CodexHistorySidebarPreferences,
): Session {
  const threadId = session.codexThreadId ?? codexHistoryThreadIdFromSessionId(session.id);
  const preference = threadId ? preferences[threadId] : undefined;
  if (!preference) return session;

  return {
    ...session,
    ...(typeof preference.pinned === "boolean" ? { pinned: preference.pinned } : {}),
    ...(typeof preference.archived === "boolean" ? { archived: preference.archived } : {}),
    ...(typeof preference.order === "number" ? { order: preference.order } : {}),
    ...(preference.title ? { title: preference.title } : {}),
    updatedAt: latestIso(session.updatedAt, preference.updatedAt),
  };
}

function mergePreferencePatch(
  existing: CodexHistorySidebarPreference,
  input: PatchSessionRequest,
): CodexHistorySidebarPreference {
  const next: CodexHistorySidebarPreference = { ...existing };
  if (typeof input.pinned === "boolean") next.pinned = input.pinned;
  if (typeof input.archived === "boolean") next.archived = input.archived;
  if (typeof input.order === "number") next.order = input.order;
  if (typeof input.title === "string") next.title = input.title;

  if (input.pinned === true) next.archived = false;
  if (input.archived === true) next.pinned = false;

  next.updatedAt = now();
  return next;
}

function normalizePreference(value: unknown): CodexHistorySidebarPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const preference: CodexHistorySidebarPreference = {};

  if (typeof input.pinned === "boolean") preference.pinned = input.pinned;
  if (typeof input.archived === "boolean") preference.archived = input.pinned === true ? false : input.archived;
  if (typeof input.order === "number" && Number.isFinite(input.order)) preference.order = input.order;
  if (typeof input.title === "string") {
    const title = input.title.trim();
    if (title) preference.title = title.slice(0, 120);
  }
  if (typeof input.updatedAt === "string" && Number.isFinite(Date.parse(input.updatedAt))) {
    preference.updatedAt = input.updatedAt;
  }

  if (preference.archived === true) preference.pinned = false;
  return preference;
}

function latestIso(left: string, right: string | null | undefined): string {
  if (!right) return left;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left;
  return rightMs > leftMs ? right : left;
}
