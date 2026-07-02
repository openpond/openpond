import { promises as fs } from "node:fs";
import path from "node:path";
import sqlite3 from "sqlite3";
import type {
  Approval,
  ContextUsageSnapshot,
  InsightItem,
  InsightStatus,
  RuntimeEvent,
  Session,
  SidebarAppPreference,
  SidebarAppPreferences,
  Turn,
} from "@openpond/contracts";
import { ContextUsageSnapshotSchema } from "@openpond/contracts";
import type {
  CacheEntry,
  CacheEntryRow,
  CacheRow,
  PayloadRow,
  SidebarAppPreferenceRow,
  StoreData,
} from "../types.js";
import type { Logger } from "../logger.js";
import { normalizeSidebarAppPreference } from "../preferences.js";
import { sanitizeRuntimeEvent } from "../runtime/runtime-event-sanitizer.js";
import { now } from "../utils.js";
import { CURRENT_SQLITE_SCHEMA_VERSION, SQLITE_CREATE_SCHEMA_SQL } from "./store-schema.js";
import { persistStoreData, readStoreData } from "./store-persistence.js";

export { CURRENT_SQLITE_SCHEMA_VERSION } from "./store-schema.js";

type UserVersionRow = {
  user_version: number;
};

type QuickCheckRow = {
  quick_check: string;
};

type TableInfoRow = {
  name: string;
};

type EventPagePayloadRow = PayloadRow & {
  sequence: number;
};

type InsightItemRow = {
  id: string;
  scope_type: string;
  scope_id: string;
  severity: string;
  type: string;
  status: string;
  fingerprint: string;
  title: string;
  summary: string;
  payload: string;
  last_run_id: string | null;
  last_run_session_id: string | null;
  last_run_turn_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  dismissed_at: string | null;
};

type ThreadDetailProjectionRow = PayloadRow & {
  session_id: string;
  event_count: number;
  latest_event_sequence: number;
  latest_event_at: string | null;
  latest_turn_id: string | null;
  latest_turn_status: Turn["status"] | null;
  pending_approval_count: number;
  updated_at: string;
};

type RuntimeEventPageQuery = {
  sessionId: string | null;
  afterSequence: number;
  beforeSequence: number | null;
  limit: number;
};

type RuntimeEventPageRows = {
  entries: Array<{ sequence: number; event: RuntimeEvent }>;
  totalMatchingEvents: number;
  remainingMatchingEvents: number;
};

type RuntimeEventRecentWindow = {
  entries: Array<{ sequence: number; event: RuntimeEvent }>;
  latestSequence: number;
  oldestSequence: number;
  totalEvents: number;
  hasMoreBefore: boolean;
  limit: number;
};

export type ThreadDetailProjection = {
  sessionId: string;
  eventCount: number;
  latestEventSequence: number;
  latestEventAt: string | null;
  latestTurnId: string | null;
  latestTurnStatus: Turn["status"] | null;
  pendingApprovalCount: number;
  updatedAt: string;
};

type SqliteStoreOptions = {
  logger?: Logger;
};

type Migration = {
  version: number;
  run: (store: SqliteStore) => Promise<void>;
};

export class SqliteStore {
  readonly storePath: string;
  private data: StoreData = { sessions: [], turns: [], events: [], approvals: [] };
  private ready: Promise<void>;
  private db: sqlite3.Database | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly logger?: Logger;

  constructor(storeDir: string, options: SqliteStoreOptions = {}) {
    this.storePath = path.join(storeDir, "state.sqlite");
    this.logger = options.logger;
    this.ready = this.load(storeDir);
  }

  async snapshot(): Promise<StoreData> {
    await this.ready;
    await this.writeQueue;
    return structuredClone(this.data);
  }

  async sessionShells(): Promise<Session[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>(
      "SELECT payload FROM projection_session_shells ORDER BY sort_index ASC",
    );
    return rows.map((row) => JSON.parse(row.payload) as Session);
  }

  async getSession(sessionId: string): Promise<Session | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>("SELECT payload FROM projection_session_shells WHERE id = ?", [sessionId]);
    return row ? JSON.parse(row.payload) as Session : null;
  }

  async pendingApprovals(): Promise<Approval[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>(
      "SELECT payload FROM projection_approvals WHERE status = ? ORDER BY sort_index ASC",
      ["pending"],
    );
    return rows.map((row) => JSON.parse(row.payload) as Approval);
  }

  async turnByProviderTurnId(providerTurnId: string): Promise<Turn | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>(
      "SELECT payload FROM turns WHERE provider_turn_id = ? ORDER BY sort_index DESC LIMIT 1",
      [providerTurnId],
    );
    return row ? JSON.parse(row.payload) as Turn : null;
  }

  async latestTurnForSession(sessionId: string, status?: Turn["status"]): Promise<Turn | null> {
    await this.ready;
    await this.writeQueue;
    if (!status) {
      const row = await this.get<PayloadRow>(
        "SELECT payload FROM projection_latest_turns WHERE session_id = ?",
        [sessionId],
      );
      return row ? JSON.parse(row.payload) as Turn : null;
    }
    const row = status
      ? await this.get<PayloadRow>(
          "SELECT payload FROM turns WHERE session_id = ? AND status = ? ORDER BY sort_index DESC LIMIT 1",
          [sessionId, status],
        )
      : null;
    return row ? JSON.parse(row.payload) as Turn : null;
  }

  async turnsForSession(sessionId: string, limit = 50): Promise<Turn[]> {
    await this.ready;
    await this.writeQueue;
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = await this.all<PayloadRow>(
      `SELECT payload FROM turns
       WHERE session_id = ?
       ORDER BY sort_index DESC
       LIMIT ?`,
      [sessionId, boundedLimit],
    );
    return rows.map((row) => JSON.parse(row.payload) as Turn);
  }

  async latestEventSequence(): Promise<number> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ sequence: number | null }>(
      "SELECT MAX(sequence) AS sequence FROM events",
      [],
    );
    return row?.sequence ?? 0;
  }

  async threadDetailProjection(sessionId: string): Promise<ThreadDetailProjection | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<ThreadDetailProjectionRow>(
      "SELECT * FROM projection_thread_details WHERE session_id = ?",
      [sessionId],
    );
    return row ? threadDetailProjectionFromRow(row) : null;
  }

  async runtimeEventPageRows(query: RuntimeEventPageQuery): Promise<RuntimeEventPageRows> {
    await this.ready;
    await this.writeQueue;
    const whereSession = query.sessionId ? "session_id = ?" : "1 = 1";
    const sessionParams = query.sessionId ? [query.sessionId] : [];
    const total = await this.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM events WHERE ${whereSession}`,
      sessionParams,
    );
    if (query.beforeSequence !== null) {
      const remainingParams = [...sessionParams, query.beforeSequence];
      const remaining = await this.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM events WHERE ${whereSession} AND sequence < ?`,
        remainingParams,
      );
      const rows = await this.all<EventPagePayloadRow>(
        `SELECT sequence, payload FROM events
         WHERE ${whereSession} AND sequence < ?
         ORDER BY sequence DESC
         LIMIT ?`,
        [...remainingParams, query.limit],
      );
      return {
        entries: rows
          .map((row) => ({
            sequence: row.sequence,
            event: runtimeEventWithSequence(row.payload, row.sequence),
          }))
          .reverse(),
        totalMatchingEvents: total?.count ?? 0,
        remainingMatchingEvents: remaining?.count ?? 0,
      };
    }

    const remainingParams = [...sessionParams, query.afterSequence];
    const remaining = await this.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM events WHERE ${whereSession} AND sequence > ?`,
      remainingParams,
    );
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE ${whereSession} AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
      [...remainingParams, query.limit],
    );
    return {
      entries: rows.map((row) => ({
        sequence: row.sequence,
        event: runtimeEventWithSequence(row.payload, row.sequence),
      })),
      totalMatchingEvents: total?.count ?? 0,
      remainingMatchingEvents: remaining?.count ?? 0,
    };
  }

  async recentRuntimeEventWindow(limit: number): Promise<RuntimeEventRecentWindow> {
    await this.ready;
    await this.writeQueue;
    const normalizedLimit = Math.max(0, Math.trunc(limit));
    const total = await this.get<{ count: number }>("SELECT COUNT(*) AS count FROM events", []);
    const latest = await this.latestEventSequence();
    if (normalizedLimit === 0) {
      return {
        entries: [],
        latestSequence: latest,
        oldestSequence: latest,
        totalEvents: total?.count ?? 0,
        hasMoreBefore: (total?.count ?? 0) > 0,
        limit: normalizedLimit,
      };
    }
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       ORDER BY sequence DESC
       LIMIT ?`,
      [normalizedLimit],
    );
    const entries = rows
      .map((row) => ({
        sequence: row.sequence,
        event: runtimeEventWithSequence(row.payload, row.sequence),
      }))
      .reverse();
    const oldestSequence = entries[0]?.sequence ?? latest;
    return {
      entries,
      latestSequence: latest,
      oldestSequence,
      totalEvents: total?.count ?? 0,
      hasMoreBefore: oldestSequence > 1,
      limit: normalizedLimit,
    };
  }

  async recentDiagnostics(limit: number): Promise<RuntimeEvent[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE name = ?
       ORDER BY sequence DESC
       LIMIT ?`,
      ["diagnostic", Math.max(0, Math.trunc(limit))],
    );
    return rows
      .map((row) => runtimeEventWithSequence(row.payload, row.sequence))
      .reverse();
  }

  async latestRuntimeEventSequenceByName(name: RuntimeEvent["name"]): Promise<number> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ sequence: number | null }>(
      "SELECT MAX(sequence) AS sequence FROM events WHERE name = ?",
      [name],
    );
    return row?.sequence ?? 0;
  }

  async runtimeEventRowsByNameAfter(
    name: RuntimeEvent["name"],
    afterSequence: number,
  ): Promise<Array<{ sequence: number; event: RuntimeEvent }>> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE name = ? AND sequence > ?
       ORDER BY sequence ASC`,
      [name, Math.max(0, Math.trunc(afterSequence))],
    );
    return rows.map((row) => ({
      sequence: row.sequence,
      event: runtimeEventWithSequence(row.payload, row.sequence),
    }));
  }

  async latestContextUsageForTurn(sessionId: string, turnId: string): Promise<ContextUsageSnapshot | null> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE session_id = ? AND turn_id = ? AND name = ?
       ORDER BY sequence DESC
       LIMIT 10`,
      [sessionId, turnId, "session.context.updated"],
    );
    for (const row of rows) {
      const runtimeEvent = runtimeEventWithSequence(row.payload, row.sequence);
      const parsed = ContextUsageSnapshotSchema.safeParse(runtimeEvent.data);
      if (parsed.success) return parsed.data;
    }
    return null;
  }

  async listInsights(query: {
    status?: InsightStatus | "all" | null;
    limit?: number;
  } = {}): Promise<InsightItem[]> {
    await this.ready;
    await this.writeQueue;
    const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 200)));
    const status = query.status && query.status !== "all" ? query.status : null;
    const rows = status
      ? await this.all<InsightItemRow>(
          `SELECT * FROM insight_items
           WHERE status = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
          [status, limit],
        )
      : await this.all<InsightItemRow>(
          `SELECT * FROM insight_items
           ORDER BY
             CASE status
               WHEN 'active' THEN 0
               WHEN 'resolved' THEN 1
               ELSE 2
             END,
             updated_at DESC
           LIMIT ?`,
          [limit],
        );
    return rows.map(insightItemFromRow);
  }

  async upsertInsightItem(item: InsightItem): Promise<InsightItem> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO insight_items (
           id,
           scope_type,
           scope_id,
           severity,
           type,
           status,
           fingerprint,
           title,
           summary,
           payload,
           last_run_id,
           last_run_session_id,
           last_run_turn_id,
           created_at,
           updated_at,
           resolved_at,
           dismissed_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id)
         DO UPDATE SET
           scope_type = excluded.scope_type,
           scope_id = excluded.scope_id,
           severity = excluded.severity,
           type = excluded.type,
           fingerprint = excluded.fingerprint,
           title = excluded.title,
           summary = excluded.summary,
           payload = excluded.payload,
           last_run_id = excluded.last_run_id,
           last_run_session_id = excluded.last_run_session_id,
           last_run_turn_id = excluded.last_run_turn_id,
           updated_at = excluded.updated_at,
           status = CASE
             WHEN insight_items.status = 'dismissed' THEN insight_items.status
             ELSE excluded.status
           END,
           resolved_at = CASE
             WHEN insight_items.status = 'dismissed' THEN insight_items.resolved_at
             ELSE excluded.resolved_at
           END,
           dismissed_at = CASE
             WHEN insight_items.status = 'dismissed' THEN insight_items.dismissed_at
             ELSE excluded.dismissed_at
           END`,
        insightItemParams(item),
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return (await this.getInsightItem(item.id)) ?? item;
  }

  async getInsightItem(id: string): Promise<InsightItem | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<InsightItemRow>("SELECT * FROM insight_items WHERE id = ?", [id]);
    return row ? insightItemFromRow(row) : null;
  }

  async patchInsightStatus(id: string, status: InsightStatus): Promise<InsightItem | null> {
    await this.ready;
    const updatedAt = now();
    const resolvedAt = status === "resolved" ? updatedAt : null;
    const dismissedAt = status === "dismissed" ? updatedAt : null;
    const write = this.writeQueue.then(async () => {
      await this.run(
        `UPDATE insight_items
         SET status = ?,
             updated_at = ?,
             resolved_at = ?,
             dismissed_at = ?
         WHERE id = ?`,
        [status, updatedAt, resolvedAt, dismissedAt, id],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return this.getInsightItem(id);
  }

  async sessionCount(): Promise<number> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ count: number }>("SELECT COUNT(*) AS count FROM sessions", []);
    return row?.count ?? 0;
  }

  async insertSessionAtFront(session: Session): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        await this.run("UPDATE sessions SET sort_index = sort_index + 1", []);
        await this.run("UPDATE projection_session_shells SET sort_index = sort_index + 1", []);
        await this.run(
          "INSERT INTO sessions (id, sort_index, payload, updated_at) VALUES (?, ?, ?, ?)",
          [session.id, 0, JSON.stringify(session), session.updatedAt],
        );
        await this.upsertSessionShellProjection(session, 0);
        await this.rebuildThreadDetailProjectionForSession(session.id);
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
      this.data.sessions.unshift(session);
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async updateSession(sessionId: string, updater: (session: Session) => Session): Promise<Session | null> {
    await this.ready;
    let updated: Session | null = null;
    const write = this.writeQueue.then(async () => {
      const index = this.data.sessions.findIndex((session) => session.id === sessionId);
      if (index === -1) return;
      updated = updater(this.data.sessions[index]!);
      await this.run(
        "UPDATE sessions SET payload = ?, updated_at = ? WHERE id = ?",
        [JSON.stringify(updated), updated.updatedAt, sessionId],
      );
      await this.upsertSessionShellProjection(updated, index);
      await this.rebuildThreadDetailProjectionForSession(sessionId);
      this.data.sessions[index] = updated;
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async updateSessionsWhere(
    predicate: (session: Session) => boolean,
    updater: (session: Session) => Session,
  ): Promise<Session[]> {
    await this.ready;
    const updated: Session[] = [];
    const write = this.writeQueue.then(async () => {
      const updates = this.data.sessions
        .map((session, index) => ({ session, index }))
        .filter(({ session }) => predicate(session))
        .map(({ session, index }) => ({ index, session: updater(session) }));
      if (updates.length === 0) return;
      await this.exec("BEGIN IMMEDIATE");
      try {
        for (const update of updates) {
          await this.run(
            "UPDATE sessions SET payload = ?, updated_at = ? WHERE id = ?",
            [JSON.stringify(update.session), update.session.updatedAt, update.session.id],
          );
          await this.upsertSessionShellProjection(update.session, update.index);
          await this.rebuildThreadDetailProjectionForSession(update.session.id);
        }
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
      for (const update of updates) {
        this.data.sessions[update.index] = update.session;
        updated.push(update.session);
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async getTurn(turnId: string): Promise<Turn | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>("SELECT payload FROM turns WHERE id = ?", [turnId]);
    return row ? JSON.parse(row.payload) as Turn : null;
  }

  async insertTurn(turn: Turn): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const index = this.data.turns.length;
      await this.run(
        "INSERT INTO turns (id, session_id, provider_turn_id, status, sort_index, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          turn.id,
          turn.sessionId,
          turn.providerTurnId,
          turn.status,
          index,
          JSON.stringify(turn),
          turn.completedAt ?? turn.startedAt,
        ],
      );
      await this.rebuildLatestTurnProjectionForSession(turn.sessionId);
      await this.rebuildThreadDetailProjectionForSession(turn.sessionId);
      this.data.turns.push(turn);
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async updateTurn(turnId: string, updater: (turn: Turn) => Turn): Promise<Turn | null> {
    await this.ready;
    let updated: Turn | null = null;
    const write = this.writeQueue.then(async () => {
      const index = this.data.turns.findIndex((turn) => turn.id === turnId);
      if (index === -1) return;
      const previousSessionId = this.data.turns[index]!.sessionId;
      updated = updater(this.data.turns[index]!);
      await this.run(
        "UPDATE turns SET session_id = ?, provider_turn_id = ?, status = ?, payload = ?, updated_at = ? WHERE id = ?",
        [
          updated.sessionId,
          updated.providerTurnId,
          updated.status,
          JSON.stringify(updated),
          updated.completedAt ?? updated.startedAt,
          turnId,
        ],
      );
      await this.rebuildLatestTurnProjectionForSession(previousSessionId);
      if (updated.sessionId !== previousSessionId) await this.rebuildLatestTurnProjectionForSession(updated.sessionId);
      await this.rebuildThreadDetailProjectionForSession(previousSessionId);
      if (updated.sessionId !== previousSessionId) await this.rebuildThreadDetailProjectionForSession(updated.sessionId);
      this.data.turns[index] = updated;
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async getApproval(approvalId: string): Promise<Approval | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>("SELECT payload FROM approvals WHERE id = ?", [approvalId]);
    return row ? JSON.parse(row.payload) as Approval : null;
  }

  async upsertApproval(approval: Approval): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const index = this.data.approvals.findIndex((candidate) => candidate.id === approval.id);
      const previousSessionId = index === -1 ? null : this.data.approvals[index]!.sessionId;
      const sortIndex = index === -1 ? this.data.approvals.length : index;
      await this.run(
        `INSERT INTO approvals (id, session_id, status, sort_index, payload, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id)
         DO UPDATE SET
           session_id = excluded.session_id,
           status = excluded.status,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        [approval.id, approval.sessionId, approval.status, sortIndex, JSON.stringify(approval), now()],
      );
      await this.upsertApprovalProjection(approval, sortIndex);
      await this.rebuildThreadDetailProjectionForSession(approval.sessionId);
      if (previousSessionId && previousSessionId !== approval.sessionId) {
        await this.rebuildThreadDetailProjectionForSession(previousSessionId);
      }
      if (index === -1) this.data.approvals.push(approval);
      else this.data.approvals[index] = approval;
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async getCacheEntry<T>(type: string, key: string): Promise<CacheEntry<T> | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<CacheRow>(
      "SELECT payload, updated_at, error FROM cache_entries WHERE type = ? AND cache_key = ?",
      [type, key]
    );
    if (!row) return null;
    return {
      payload: JSON.parse(row.payload) as T,
      updatedAt: row.updated_at,
      error: row.error,
    };
  }

  async getCacheEntriesByType<T>(type: string): Promise<Record<string, CacheEntry<T>>> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<CacheEntryRow>(
      "SELECT cache_key, payload, updated_at, error FROM cache_entries WHERE type = ?",
      [type]
    );
    const entries: Record<string, CacheEntry<T>> = {};
    for (const row of rows) {
      entries[row.cache_key] = {
        payload: JSON.parse(row.payload) as T,
        updatedAt: row.updated_at,
        error: row.error,
      };
    }
    return entries;
  }

  async setCacheEntry<T>(type: string, key: string, payload: T, error: string | null = null): Promise<CacheEntry<T>> {
    await this.ready;
    const updatedAt = now();
    const entry: CacheEntry<T> = { payload, updatedAt, error };
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO cache_entries (type, cache_key, payload, updated_at, error)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(type, cache_key)
         DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, error = excluded.error`,
        [type, key, JSON.stringify(payload), updatedAt, error]
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return entry;
  }

  async setCacheError(type: string, key: string, fallbackPayload: unknown, error: string): Promise<void> {
    const existing = await this.getCacheEntry<unknown>(type, key);
    await this.setCacheEntry(type, key, existing?.payload ?? fallbackPayload, error);
  }

  async getSidebarAppPreferences(scope: string): Promise<SidebarAppPreferences> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<SidebarAppPreferenceRow>(
      `SELECT app_id, pinned, archived, sort_order
       FROM sidebar_app_preferences
       WHERE scope = ?`,
      [scope]
    );
    const preferences: SidebarAppPreferences = {};
    for (const row of rows) {
      preferences[row.app_id] = {
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        ...(row.sort_order === null ? {} : { order: row.sort_order }),
      };
    }
    return preferences;
  }

  async patchSidebarAppPreference(
    scope: string,
    appId: string,
    patch: SidebarAppPreference
  ): Promise<SidebarAppPreference> {
    await this.ready;
    let updated: SidebarAppPreference = {};
    const write = this.writeQueue.then(async () => {
      const row = await this.get<SidebarAppPreferenceRow>(
        `SELECT app_id, pinned, archived, sort_order
         FROM sidebar_app_preferences
         WHERE scope = ? AND app_id = ?`,
        [scope, appId]
      );
      const existing: SidebarAppPreference = row
        ? {
            pinned: row.pinned === 1,
            archived: row.archived === 1,
            ...(row.sort_order === null ? {} : { order: row.sort_order }),
          }
        : {};
      updated = normalizeSidebarAppPreference({ ...existing, ...patch });
      await this.run(
        `INSERT INTO sidebar_app_preferences (scope, app_id, pinned, archived, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, app_id)
         DO UPDATE SET
           pinned = excluded.pinned,
           archived = excluded.archived,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
        [scope, appId, updated.pinned ? 1 : 0, updated.archived ? 1 : 0, updated.order ?? null, now()]
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async reorderSidebarApps(scope: string, appIds: string[]): Promise<SidebarAppPreferences> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const updatedAt = now();
      await this.exec("BEGIN IMMEDIATE");
      try {
        for (const [index, appId] of appIds.entries()) {
          await this.run(
            `INSERT INTO sidebar_app_preferences (scope, app_id, pinned, archived, sort_order, updated_at)
             VALUES (?, ?, 0, 0, ?, ?)
             ON CONFLICT(scope, app_id)
             DO UPDATE SET sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
            [scope, appId, index, updatedAt]
          );
        }
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK");
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return this.getSidebarAppPreferences(scope);
  }

  async mutate(fn: (data: StoreData) => void): Promise<StoreData> {
    await this.ready;
    let snapshot: StoreData = { sessions: [], turns: [], events: [], approvals: [] };
    const write = this.writeQueue.then(async () => {
      fn(this.data);
      await this.persist();
      await this.rebuildReadModels();
      snapshot = structuredClone(this.data);
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return snapshot;
  }

  async appendRuntimeEvent(runtimeEvent: StoreData["events"][number]): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const safeRuntimeEvent = sanitizeRuntimeEvent(runtimeEvent);
      const index = this.data.events.length;
      const sequence = await this.nextEventSequence();
      await this.run(
        "INSERT INTO events (id, session_id, turn_id, name, timestamp, sequence, sort_index, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          safeRuntimeEvent.id,
          safeRuntimeEvent.sessionId ?? null,
          safeRuntimeEvent.turnId ?? null,
          safeRuntimeEvent.name,
          safeRuntimeEvent.timestamp,
          sequence,
          index,
          JSON.stringify(safeRuntimeEvent),
        ]
      );
      if (safeRuntimeEvent.sessionId) {
        await this.updateThreadDetailProjectionForEvent(safeRuntimeEvent, sequence);
      }
      this.data.events.push(safeRuntimeEvent);
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async runtimeEventContext(
    sessionId: string,
    providerTurnId?: string | null
  ): Promise<{ appId?: string | null; turnId?: string | null }> {
    await this.ready;
    await this.writeQueue;
    const turn = providerTurnId
      ? await this.turnByProviderTurnId(providerTurnId)
      : await this.latestTurnForSession(sessionId, "in_progress");
    const session = await this.getSession(sessionId);
    return {
      appId: session?.appId,
      turnId: turn?.id,
    };
  }

  private async load(storeDir: string): Promise<void> {
    await fs.mkdir(storeDir, { recursive: true });
    const hadDatabase = await this.fileExists(this.storePath);
    await this.openDatabaseWithRecovery(storeDir);
    await this.configureDatabase();
    await this.assertHealthyDatabase();
    await this.runMigrations(storeDir, hadDatabase);
    this.data = await readStoreData({
      allPayloadRows: (sql, params) => this.all<PayloadRow>(sql, params),
    });
  }

  private async configureDatabase(): Promise<void> {
    await this.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
    `);
  }

  private async assertHealthyDatabase(): Promise<void> {
    const rows = await this.all<QuickCheckRow>("PRAGMA quick_check");
    const failures = rows.map((row) => row.quick_check).filter((value) => value !== "ok");
    if (failures.length > 0) {
      throw new Error(`SQLite quick_check failed: ${failures.join("; ")}`);
    }
  }

  private async runMigrations(storeDir: string, hadDatabase: boolean): Promise<void> {
    const currentVersion = await this.userVersion();
    if (currentVersion > CURRENT_SQLITE_SCHEMA_VERSION) {
      throw new Error(
        `SQLite schema version ${currentVersion} is newer than this app supports (${CURRENT_SQLITE_SCHEMA_VERSION})`
      );
    }
    if (currentVersion === CURRENT_SQLITE_SCHEMA_VERSION) return;

    if (hadDatabase) await this.backupDatabaseFiles(storeDir, `before-v${currentVersion + 1}`);

    for (const migration of SQLITE_MIGRATIONS.filter((candidate) => candidate.version > currentVersion)) {
      await this.exec("BEGIN IMMEDIATE");
      try {
        await migration.run(this);
        await this.exec(`PRAGMA user_version = ${migration.version}`);
        await this.exec("COMMIT");
        this.logger?.info("sqlite migration completed", { version: migration.version, storePath: this.storePath });
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        this.logger?.error("sqlite migration failed", { version: migration.version, error });
        throw error;
      }
    }
  }

  private async userVersion(): Promise<number> {
    const row = await this.get<UserVersionRow>("PRAGMA user_version", []);
    return row?.user_version ?? 0;
  }

  private async openDatabaseWithRecovery(storeDir: string): Promise<void> {
    try {
      this.db = await this.openDatabase(this.storePath);
    } catch (error) {
      this.logger?.error("sqlite open failed; moving database files aside", { storePath: this.storePath, error });
      await this.moveDatabaseFilesAside(storeDir, "open-failed");
      this.db = await this.openDatabase(this.storePath);
    }

    try {
      await this.configureDatabase();
      await this.assertHealthyDatabase();
    } catch (error) {
      this.logger?.error("sqlite health check failed; moving database files aside", { storePath: this.storePath, error });
      await this.closeDatabaseHandle();
      await this.moveDatabaseFilesAside(storeDir, "quick-check-failed");
      this.db = await this.openDatabase(this.storePath);
    }
  }

  private async backupDatabaseFiles(storeDir: string, label: string): Promise<void> {
    await this.exec("PRAGMA wal_checkpoint(FULL)").catch(() => undefined);
    const backupDir = path.join(storeDir, "backups", `state-${timestampForPath()}-${label}`);
    await fs.mkdir(backupDir, { recursive: true });
    let copied = 0;
    for (const filePath of this.databaseFiles()) {
      try {
        await fs.copyFile(filePath, path.join(backupDir, path.basename(filePath)));
        copied += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.logger?.info("sqlite backup created", { backupDir, copied });
  }

  private async moveDatabaseFilesAside(storeDir: string, reason: string): Promise<void> {
    const corruptDir = path.join(storeDir, "corrupt");
    await fs.mkdir(corruptDir, { recursive: true });
    const stamp = timestampForPath();
    let moved = 0;
    for (const filePath of this.databaseFiles()) {
      const suffix = filePath.slice(this.storePath.length);
      const target = path.join(corruptDir, `state-${stamp}-${reason}.sqlite${suffix}`);
      try {
        await fs.rename(filePath, target);
        moved += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.logger?.warn("sqlite database files moved aside", { reason, moved, corruptDir });
  }

  private databaseFiles(): string[] {
    return [this.storePath, `${this.storePath}-wal`, `${this.storePath}-shm`];
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async createSchema(): Promise<void> {
    await this.exec(SQLITE_CREATE_SCHEMA_SQL);
  }

  async createHotQueryIndexes(): Promise<void> {
    await this.addColumnIfMissing("turns", "provider_turn_id", "TEXT");
    await this.addColumnIfMissing("turns", "status", "TEXT");
    await this.backfillTurnQueryColumns();
    await this.exec(`
      CREATE INDEX IF NOT EXISTS turns_session_sort_idx ON turns(session_id, sort_index DESC);
      CREATE INDEX IF NOT EXISTS turns_session_status_sort_idx ON turns(session_id, status, sort_index DESC);
      CREATE INDEX IF NOT EXISTS turns_provider_turn_id_idx ON turns(provider_turn_id);
      CREATE INDEX IF NOT EXISTS events_session_sort_idx ON events(session_id, sort_index);
      CREATE INDEX IF NOT EXISTS approvals_status_sort_idx ON approvals(status, sort_index);
    `);
  }

  async createReadModelTables(): Promise<void> {
    await this.addColumnIfMissing("events", "sequence", "INTEGER");
    await this.run("UPDATE events SET sequence = sort_index + 1 WHERE sequence IS NULL", []);
    await this.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS events_sequence_idx ON events(sequence);
      CREATE INDEX IF NOT EXISTS events_session_sequence_idx ON events(session_id, sequence);

      CREATE TABLE IF NOT EXISTS projection_session_shells (
        id TEXT PRIMARY KEY,
        sort_index INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projection_thread_details (
        session_id TEXT PRIMARY KEY,
        event_count INTEGER NOT NULL,
        latest_event_sequence INTEGER NOT NULL,
        latest_event_at TEXT,
        latest_turn_id TEXT,
        latest_turn_status TEXT,
        pending_approval_count INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projection_approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        sort_index INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS projection_approvals_status_sort_idx
        ON projection_approvals(status, sort_index);

      CREATE TABLE IF NOT EXISTS projection_latest_turns (
        session_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        status TEXT NOT NULL,
        sort_index INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    await this.rebuildReadModels();
  }

  async createInsightTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS insight_items (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT NOT NULL,
        last_run_id TEXT,
        last_run_session_id TEXT,
        last_run_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        dismissed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS insight_items_scope_status_idx
        ON insight_items(scope_type, scope_id, status, updated_at);

      CREATE INDEX IF NOT EXISTS insight_items_fingerprint_idx
        ON insight_items(fingerprint);
    `);
    await this.addColumnIfMissing("insight_items", "last_run_id", "TEXT");
    await this.addColumnIfMissing("insight_items", "last_run_session_id", "TEXT");
    await this.addColumnIfMissing("insight_items", "last_run_turn_id", "TEXT");
  }

  async createInsightRunLinkColumns(): Promise<void> {
    await this.addColumnIfMissing("insight_items", "last_run_id", "TEXT");
    await this.addColumnIfMissing("insight_items", "last_run_session_id", "TEXT");
    await this.addColumnIfMissing("insight_items", "last_run_turn_id", "TEXT");
  }

  private async addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
    const rows = await this.all<TableInfoRow>(`PRAGMA table_info(${table})`);
    if (rows.some((row) => row.name === column)) return;
    await this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private async backfillTurnQueryColumns(): Promise<void> {
    const rows = await this.all<(PayloadRow & { id: string })>("SELECT id, payload FROM turns");
    for (const row of rows) {
      const turn = JSON.parse(row.payload) as Partial<Turn>;
      await this.run(
        "UPDATE turns SET provider_turn_id = ?, status = ? WHERE id = ?",
        [turn.providerTurnId ?? null, turn.status ?? null, row.id],
      );
    }
  }

  private async nextEventSequence(): Promise<number> {
    const row = await this.get<{ sequence: number | null }>("SELECT MAX(sequence) AS sequence FROM events", []);
    return (row?.sequence ?? 0) + 1;
  }

  private async upsertSessionShellProjection(session: Session, sortIndex: number): Promise<void> {
    await this.run(
      `INSERT INTO projection_session_shells (id, sort_index, payload, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id)
       DO UPDATE SET
         sort_index = excluded.sort_index,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [session.id, sortIndex, JSON.stringify(session), session.updatedAt],
    );
  }

  private async upsertApprovalProjection(approval: Approval, sortIndex: number): Promise<void> {
    await this.run(
      `INSERT INTO projection_approvals (id, session_id, status, sort_index, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id)
       DO UPDATE SET
         session_id = excluded.session_id,
         status = excluded.status,
         sort_index = excluded.sort_index,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [approval.id, approval.sessionId, approval.status, sortIndex, JSON.stringify(approval), now()],
    );
  }

  private async rebuildLatestTurnProjectionForSession(sessionId: string): Promise<void> {
    const row = await this.get<PayloadRow & { id: string; status: Turn["status"]; sort_index: number; updated_at: string }>(
      `SELECT id, status, sort_index, payload, updated_at
       FROM turns
       WHERE session_id = ?
       ORDER BY sort_index DESC
       LIMIT 1`,
      [sessionId],
    );
    if (!row) {
      await this.run("DELETE FROM projection_latest_turns WHERE session_id = ?", [sessionId]);
      return;
    }
    await this.run(
      `INSERT INTO projection_latest_turns (session_id, turn_id, status, sort_index, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id)
       DO UPDATE SET
         turn_id = excluded.turn_id,
         status = excluded.status,
         sort_index = excluded.sort_index,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [sessionId, row.id, row.status, row.sort_index, row.payload, row.updated_at],
    );
  }

  private async rebuildThreadDetailProjectionForSession(sessionId: string): Promise<void> {
    const eventStats = await this.get<{
      event_count: number;
      latest_event_sequence: number | null;
      latest_event_at: string | null;
    }>(
      `SELECT
         COUNT(*) AS event_count,
         MAX(sequence) AS latest_event_sequence,
         MAX(timestamp) AS latest_event_at
       FROM events
       WHERE session_id = ?`,
      [sessionId],
    );
    const latestTurn = await this.get<{ turn_id: string; status: Turn["status"] }>(
      "SELECT turn_id, status FROM projection_latest_turns WHERE session_id = ?",
      [sessionId],
    );
    const pendingApprovals = await this.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM projection_approvals WHERE session_id = ? AND status = ?",
      [sessionId, "pending"],
    );
    const projection = threadDetailProjectionPayload({
      sessionId,
      eventCount: eventStats?.event_count ?? 0,
      latestEventSequence: eventStats?.latest_event_sequence ?? 0,
      latestEventAt: eventStats?.latest_event_at ?? null,
      latestTurnId: latestTurn?.turn_id ?? null,
      latestTurnStatus: latestTurn?.status ?? null,
      pendingApprovalCount: pendingApprovals?.count ?? 0,
      updatedAt: now(),
    });
    await this.run(
      `INSERT INTO projection_thread_details (
         session_id,
         event_count,
         latest_event_sequence,
         latest_event_at,
         latest_turn_id,
         latest_turn_status,
         pending_approval_count,
         payload,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id)
       DO UPDATE SET
         event_count = excluded.event_count,
         latest_event_sequence = excluded.latest_event_sequence,
         latest_event_at = excluded.latest_event_at,
         latest_turn_id = excluded.latest_turn_id,
         latest_turn_status = excluded.latest_turn_status,
         pending_approval_count = excluded.pending_approval_count,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [
        projection.sessionId,
        projection.eventCount,
        projection.latestEventSequence,
        projection.latestEventAt,
        projection.latestTurnId,
        projection.latestTurnStatus,
        projection.pendingApprovalCount,
        JSON.stringify(projection),
        projection.updatedAt,
      ],
    );
  }

  private async updateThreadDetailProjectionForEvent(event: RuntimeEvent, sequence: number): Promise<void> {
    if (!event.sessionId) return;
    const existing = await this.threadDetailProjectionFromDb(event.sessionId);
    const projection = threadDetailProjectionPayload({
      sessionId: event.sessionId,
      eventCount: (existing?.eventCount ?? 0) + 1,
      latestEventSequence: sequence,
      latestEventAt: event.timestamp,
      latestTurnId: existing?.latestTurnId ?? null,
      latestTurnStatus: existing?.latestTurnStatus ?? null,
      pendingApprovalCount: existing?.pendingApprovalCount ?? 0,
      updatedAt: event.timestamp,
    });
    await this.run(
      `INSERT INTO projection_thread_details (
         session_id,
         event_count,
         latest_event_sequence,
         latest_event_at,
         latest_turn_id,
         latest_turn_status,
         pending_approval_count,
         payload,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id)
       DO UPDATE SET
         event_count = excluded.event_count,
         latest_event_sequence = excluded.latest_event_sequence,
         latest_event_at = excluded.latest_event_at,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [
        projection.sessionId,
        projection.eventCount,
        projection.latestEventSequence,
        projection.latestEventAt,
        projection.latestTurnId,
        projection.latestTurnStatus,
        projection.pendingApprovalCount,
        JSON.stringify(projection),
        projection.updatedAt,
      ],
    );
  }

  private async threadDetailProjectionFromDb(sessionId: string): Promise<ThreadDetailProjection | null> {
    const row = await this.get<ThreadDetailProjectionRow>(
      "SELECT * FROM projection_thread_details WHERE session_id = ?",
      [sessionId],
    );
    return row ? threadDetailProjectionFromRow(row) : null;
  }

  private async rebuildReadModels(): Promise<void> {
    await this.exec(`
      DELETE FROM projection_latest_turns;
      DELETE FROM projection_approvals;
      DELETE FROM projection_thread_details;
      DELETE FROM projection_session_shells;
    `);
    const sessions = await this.all<(PayloadRow & { sort_index: number })>(
      "SELECT sort_index, payload FROM sessions ORDER BY sort_index ASC",
    );
    const sessionIds = new Set<string>();
    for (const row of sessions) {
      const session = JSON.parse(row.payload) as Session;
      sessionIds.add(session.id);
      await this.upsertSessionShellProjection(session, row.sort_index);
    }
    const approvals = await this.all<(PayloadRow & { sort_index: number })>(
      "SELECT sort_index, payload FROM approvals ORDER BY sort_index ASC",
    );
    for (const row of approvals) {
      const approval = JSON.parse(row.payload) as Approval;
      sessionIds.add(approval.sessionId);
      await this.upsertApprovalProjection(approval, row.sort_index);
    }
    const turnSessionRows = await this.all<{ session_id: string }>("SELECT DISTINCT session_id FROM turns", []);
    const eventSessionRows = await this.all<{ session_id: string | null }>(
      "SELECT DISTINCT session_id FROM events WHERE session_id IS NOT NULL",
      [],
    );
    for (const row of turnSessionRows) sessionIds.add(row.session_id);
    for (const row of eventSessionRows) {
      if (row.session_id) sessionIds.add(row.session_id);
    }
    for (const sessionId of sessionIds) {
      await this.rebuildLatestTurnProjectionForSession(sessionId);
      await this.rebuildThreadDetailProjectionForSession(sessionId);
    }
  }

  private async persist(): Promise<void> {
    await persistStoreData(this.data, {
      exec: (sql) => this.exec(sql),
      run: (sql, params) => this.run(sql, params),
    });
  }

  async close(): Promise<void> {
    await this.ready;
    await this.writeQueue;
    await this.closeDatabaseHandle();
  }

  private async closeDatabaseHandle(): Promise<void> {
    const db = this.db;
    this.db = null;
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      db.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private openDatabase(filename: string): Promise<sqlite3.Database> {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(filename, (error) => {
        if (error) reject(error);
        else resolve(db);
      });
    });
  }

  private exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.database.exec(sql, (error) => (error ? reject(error) : resolve()));
    });
  }

  private run(sql: string, params: unknown[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.database.run(sql, params, (error) => (error ? reject(error) : resolve()));
    });
  }

  private all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.database.all(sql, params, (error, rows: T[]) => (error ? reject(error) : resolve(rows)));
    });
  }

  private get<T>(sql: string, params: unknown[]): Promise<T | null> {
    return new Promise((resolve, reject) => {
      this.database.get(sql, params, (error, row: T | undefined) => (error ? reject(error) : resolve(row ?? null)));
    });
  }

  private get database(): sqlite3.Database {
    if (!this.db) throw new Error("SQLite store is not ready");
    return this.db;
  }
}

const SQLITE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    run: (store) => store.createSchema(),
  },
  {
    version: 2,
    run: (store) => store.createHotQueryIndexes(),
  },
  {
    version: 3,
    run: (store) => store.createReadModelTables(),
  },
  {
    version: 4,
    run: (store) => store.createInsightTables(),
  },
  {
    version: 5,
    run: (store) => store.createInsightRunLinkColumns(),
  },
  {
    version: 6,
    run: (store) => store.createInsightRunLinkColumns(),
  },
];

function insightItemFromRow(row: InsightItemRow): InsightItem {
  return {
    id: row.id,
    scopeType: row.scope_type as InsightItem["scopeType"],
    scopeId: row.scope_id,
    severity: row.severity as InsightItem["severity"],
    type: row.type,
    status: row.status as InsightItem["status"],
    fingerprint: row.fingerprint,
    title: row.title,
    summary: row.summary,
    payload: JSON.parse(row.payload) as InsightItem["payload"],
    lastRunId: row.last_run_id,
    lastRunSessionId: row.last_run_session_id,
    lastRunTurnId: row.last_run_turn_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    dismissedAt: row.dismissed_at,
  };
}

function insightItemParams(item: InsightItem): unknown[] {
  return [
    item.id,
    item.scopeType,
    item.scopeId,
    item.severity,
    item.type,
    item.status,
    item.fingerprint,
    item.title,
    item.summary,
    JSON.stringify(item.payload),
    item.lastRunId ?? null,
    item.lastRunSessionId ?? null,
    item.lastRunTurnId ?? null,
    item.createdAt,
    item.updatedAt,
    item.resolvedAt,
    item.dismissedAt,
  ];
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

function runtimeEventWithSequence(payload: string, sequence: number): RuntimeEvent {
  return {
    ...sanitizeRuntimeEvent(JSON.parse(payload) as RuntimeEvent),
    sequence,
  };
}

function threadDetailProjectionFromRow(row: ThreadDetailProjectionRow): ThreadDetailProjection {
  return threadDetailProjectionPayload({
    sessionId: row.session_id,
    eventCount: row.event_count,
    latestEventSequence: row.latest_event_sequence,
    latestEventAt: row.latest_event_at,
    latestTurnId: row.latest_turn_id,
    latestTurnStatus: row.latest_turn_status,
    pendingApprovalCount: row.pending_approval_count,
    updatedAt: row.updated_at,
  });
}

function threadDetailProjectionPayload(input: ThreadDetailProjection): ThreadDetailProjection {
  return {
    sessionId: input.sessionId,
    eventCount: input.eventCount,
    latestEventSequence: input.latestEventSequence,
    latestEventAt: input.latestEventAt,
    latestTurnId: input.latestTurnId,
    latestTurnStatus: input.latestTurnStatus,
    pendingApprovalCount: input.pendingApprovalCount,
    updatedAt: input.updatedAt,
  };
}
