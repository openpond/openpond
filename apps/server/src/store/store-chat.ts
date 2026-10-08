import type { PonderDesktopOperation } from "@openpond/contracts/ponder-desktop";
import { assertPonderDesktopRecipient } from "./ponder-desktop-input.js";
import { ponderDesktopSessionRevision } from "../openpond/ponder-desktop-catalog.js";
import { attachPonderSessionOwner } from "./ponder-session-attachment.js";
import type {
  Approval,
  RuntimeEvent,
  Session,
  Turn
} from "@openpond/contracts";
import { listCache, readCache, writeCache } from "@openpond/persistence";
import { sanitizeRuntimeEvent } from "../runtime/runtime-event-sanitizer.js";
import type {
  CacheEntry,
  PayloadRow,
  StoreData
} from "../types.js";
import { now } from "../utils.js";
import type { RuntimeHistoryStorage } from "./runtime-history-storage.js";
import {
  sessionRuntimeSummaries,
  sessionWithRuntimeSummary,
} from "./session-runtime-summary.js";
import { sessionWithSidebarActivity } from "./session-sidebar-activity.js";
import { openNodeSqliteConnection } from "./sqlite/sqlite-driver-node.js";
import {
  runtimeEventWithSequence,
  threadDetailProjectionFromRow,
  type ThreadDetailProjection
} from "./store-codecs.js";
import { SqliteStoreCore } from "./store-core.js";
import { normalizeSessionPayload } from "./store-persistence.js";





type EventPagePayloadRow = PayloadRow & {
  sequence: number;
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
  entries: Array<{ sequence: number; event: RuntimeEvent; }>;
  totalMatchingEvents: number;
  remainingMatchingEvents: number;
};

type RuntimeEventRecentWindow = {
  entries: Array<{ sequence: number; event: RuntimeEvent; }>;
  latestSequence: number;
  oldestSequence: number;
  totalEvents: number;
  hasMoreBefore: boolean;
  limit: number;
};

export class SqliteChatStore extends SqliteStoreCore implements RuntimeHistoryStorage {
  async attachPonderSessionOwner(input: Parameters<typeof attachPonderSessionOwner>[1]) {
    await this.ready;
    const write = this.writeQueue.then(() => {
      const db = this.database;
      db.exec("BEGIN IMMEDIATE");
      try {
        const session = attachPonderSessionOwner(db, input);
        db.run("UPDATE projection_session_shells SET payload = ?, updated_at = ? WHERE id = ?",
          [JSON.stringify(session), session.updatedAt, session.id]);
        db.exec("COMMIT");
        const index = this.data.sessions.findIndex(item => item.id === session.id);
        if (index >= 0) this.data.sessions[index] = session;
        return session;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    this.writeQueue = write.then(() => {}, () => {});
    return write;
  }
  readonly harnessStoragePlacement = "local" as const;
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
    const runtimeBySessionId = sessionRuntimeSummaries(this.data.turns);
    return rows.map((row) => {
      const session = normalizeSessionPayload(JSON.parse(row.payload));
      return sessionWithRuntimeSummary(
        session,
        runtimeBySessionId.get(session.id)
      );
    });
  }

  async getSession(sessionId: string): Promise<Session | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>("SELECT payload FROM projection_session_shells WHERE id = ?", [sessionId]);
    if (!row) return null;
    const session = normalizeSessionPayload(JSON.parse(row.payload));
    return sessionWithRuntimeSummary(
      session,
      sessionRuntimeSummaries(this.data.turns).get(sessionId)
    );
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

  async latestPersistedTurnForSession(sessionId: string, status?: Turn["status"]): Promise<Turn | null> {
    await this.ready;
    // Managed-child completion polling must be able to observe a committed
    // terminal turn even while provider cleanup has a later write queued. This
    // intentionally skips the general read-after-write barrier; callers use it
    // only as a durable lifecycle signal and continue normal serialized writes
    // for the resulting run transition.
    const sql = status
      ? "SELECT payload FROM turns WHERE session_id = ? AND status = ? ORDER BY sort_index DESC LIMIT 1"
      : "SELECT payload FROM turns WHERE session_id = ? ORDER BY sort_index DESC LIMIT 1";
    const row = await this.persistedLifecycleRow<PayloadRow>(
      sql,
      status ? [sessionId, status] : [sessionId],
    );
    return row ? JSON.parse(row.payload) as Turn : null;
  }

  private async persistedLifecycleRow<Row>(sql: string, params: unknown[]): Promise<Row | null> {
    const database = openNodeSqliteConnection(this.storePath);
    try {
      return database.get<Row>(sql, params);
    } finally {
      database.close();
    }
  }

  private async persistedLifecycleRows<Row>(sql: string, params: unknown[]): Promise<Row[]> {
    const database = openNodeSqliteConnection(this.storePath);
    try {
      return database.all<Row>(sql, params);
    } finally {
      database.close();
    }
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

  /** Cursor reads stay bounded even when other sessions grow without limit. */
  async turnPageForSession(input: {
    sessionId: string;
    beforeSortIndex?: number | null;
    limit?: number;
  }): Promise<{ turns: Turn[]; nextBeforeSortIndex: number | null; }> {
    await this.ready;
    await this.writeQueue;
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
    const before = input.beforeSortIndex;
    const rows = await this.all<PayloadRow & { sort_index: number; }>(
      `SELECT sort_index, payload FROM turns
       WHERE session_id = ? ${before === undefined || before === null ? "" : "AND sort_index < ?"}
       ORDER BY sort_index DESC LIMIT ?`,
      before === undefined || before === null
        ? [input.sessionId, limit + 1]
        : [input.sessionId, Math.max(0, Math.trunc(before)), limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      turns: page.map((row) => JSON.parse(row.payload) as Turn),
      nextBeforeSortIndex: hasMore ? page[page.length - 1]!.sort_index : null,
    };
  }

  async countTurnsForSession(sessionId: string): Promise<number> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ count: number; }>(
      "SELECT COUNT(*) AS count FROM turns WHERE session_id = ?",
      [sessionId],
    );
    return row?.count ?? 0;
  }

  async hasSubagentParentWakeTurn(sessionId: string, messageId: string): Promise<boolean> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ count: number; }>(
      `SELECT COUNT(*) AS count FROM turns
       WHERE session_id = ?
         AND json_extract(payload, '$.metadata.subagentParentWake.messageId') = ?`,
      [sessionId, messageId],
    );
    return (row?.count ?? 0) > 0;
  }

  async countSubagentParentWakeTurns(sessionId: string, fromRunId: string): Promise<number> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ count: number; }>(
      `SELECT COUNT(*) AS count FROM turns
       WHERE session_id = ?
         AND json_extract(payload, '$.metadata.subagentParentWake.fromRunId') = ?`,
      [sessionId, fromRunId],
    );
    return row?.count ?? 0;
  }

  async latestEventSequence(): Promise<number> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ sequence: number | null; }>(
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
    const total = await this.get<{ count: number; }>(
      `SELECT COUNT(*) AS count FROM events WHERE ${whereSession}`,
      sessionParams,
    );
    if (query.beforeSequence !== null) {
      const remainingParams = [...sessionParams, query.beforeSequence];
      const remaining = await this.get<{ count: number; }>(
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
    const remaining = await this.get<{ count: number; }>(
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

  async runtimeEventsForSession(
    sessionId: string,
    query: {
      afterSequence?: number | null;
      names?: readonly RuntimeEvent["name"][];
      limit?: number | null;
      excludeReasoningDeltas?: boolean;
    } = {},
  ): Promise<RuntimeEvent[]> {
    await this.ready;
    await this.writeQueue;
    const where = ["session_id = ?"];
    const params: unknown[] = [sessionId];
    if (query.afterSequence !== undefined && query.afterSequence !== null) {
      where.push("sequence > ?");
      params.push(Math.max(0, Math.trunc(query.afterSequence)));
    }
    if (query.names && query.names.length > 0) {
      where.push(`name IN (${query.names.map(() => "?").join(", ")})`);
      params.push(...query.names);
    }
    if (query.excludeReasoningDeltas) where.push("name <> 'assistant.reasoning.delta'");
    const limit = query.limit === undefined || query.limit === null
      ? null
      : Math.max(1, Math.min(100_000, Math.trunc(query.limit)));
    if (limit !== null) params.push(limit);
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE ${where.join(" AND ")}
       ORDER BY sequence ASC
       ${limit === null ? "" : "LIMIT ?"}`,
      params,
    );
    return rows.map((row) => runtimeEventWithSequence(row.payload, row.sequence));
  }

  async runtimeEventsForTurn(
    turnId: string,
    query: {
      names?: readonly RuntimeEvent["name"][];
      limit?: number | null;
    } = {},
  ): Promise<RuntimeEvent[]> {
    await this.ready;
    await this.writeQueue;
    const where = ["turn_id = ?"];
    const params: unknown[] = [turnId];
    if (query.names && query.names.length > 0) {
      where.push(`name IN (${query.names.map(() => "?").join(", ")})`);
      params.push(...query.names);
    }
    const limit = query.limit === undefined || query.limit === null
      ? null
      : Math.max(1, Math.min(100_000, Math.trunc(query.limit)));
    if (limit !== null) params.push(limit);
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE ${where.join(" AND ")}
       ORDER BY sequence ASC
       ${limit === null ? "" : "LIMIT ?"}`,
      params,
    );
    return rows.map((row) => runtimeEventWithSequence(row.payload, row.sequence));
  }

  async persistedRuntimeEventsForSession(
    sessionId: string,
    query: {
      afterSequence?: number | null;
      names?: readonly RuntimeEvent["name"][];
      limit?: number | null;
    } = {},
  ): Promise<RuntimeEvent[]> {
    await this.ready;
    const where = ["session_id = ?"];
    const params: unknown[] = [sessionId];
    if (query.afterSequence !== undefined && query.afterSequence !== null) {
      where.push("sequence > ?");
      params.push(Math.max(0, Math.trunc(query.afterSequence)));
    }
    if (query.names && query.names.length > 0) {
      where.push(`name IN (${query.names.map(() => "?").join(", ")})`);
      params.push(...query.names);
    }
    const limit = query.limit === undefined || query.limit === null
      ? null
      : Math.max(1, Math.min(100_000, Math.trunc(query.limit)));
    if (limit !== null) params.push(limit);
    const rows = await this.persistedLifecycleRows<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE ${where.join(" AND ")}
       ORDER BY sequence ASC
       ${limit === null ? "" : "LIMIT ?"}`,
      params,
    );
    return rows.map((row) => runtimeEventWithSequence(row.payload, row.sequence));
  }

  async latestAssistantTextForSession(sessionId: string): Promise<string | null> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE session_id = ? AND name = ?
       ORDER BY sequence DESC
       LIMIT 25`,
      [sessionId, "assistant.delta"],
    );
    for (const row of rows) {
      const output = runtimeEventWithSequence(row.payload, row.sequence).output?.trim();
      if (output) return output;
    }
    return null;
  }

  async recentRuntimeEventWindow(limit: number): Promise<RuntimeEventRecentWindow> {
    await this.ready;
    await this.writeQueue;
    const normalizedLimit = Math.max(0, Math.trunc(limit));
    const total = await this.get<{ count: number; }>("SELECT COUNT(*) AS count FROM events", []);
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
    const row = await this.get<{ sequence: number | null; }>(
      "SELECT MAX(sequence) AS sequence FROM events WHERE name = ?",
      [name],
    );
    return row?.sequence ?? 0;
  }

  async runtimeEventRowsByNameAfter(
    name: RuntimeEvent["name"],
    afterSequence: number,
  ): Promise<Array<{ sequence: number; event: RuntimeEvent; }>> {
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

  async sessionCount(): Promise<number> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ count: number; }>("SELECT COUNT(*) AS count FROM sessions", []);
    return row?.count ?? 0;
  }

  async insertSessionAtFront(session: Session, desktopOperation?: PonderDesktopOperation): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(() => {
      const db = this.database;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (desktopOperation) assertPonderDesktopRecipient(db, desktopOperation,
          session, null, ponderDesktopSessionRevision(session, null));
        db.run("UPDATE sessions SET sort_index = sort_index + 1", []);
        db.run("UPDATE projection_session_shells SET sort_index = sort_index + 1", []);
        db.run(
          "INSERT INTO sessions (id, sort_index, payload, updated_at) VALUES (?, ?, ?, ?)",
          [session.id, 0, JSON.stringify(session), session.updatedAt],
        );
        db.run("INSERT INTO projection_session_shells (id, sort_index, payload, updated_at) VALUES (?, 0, ?, ?)",
          [session.id, JSON.stringify(session), session.updatedAt]);
        const detail = { sessionId: session.id, eventCount: 0, latestEventSequence: 0, latestEventAt: null,
          latestTurnId: null, latestTurnStatus: null, pendingApprovalCount: 0, updatedAt: session.updatedAt };
        db.run(`INSERT INTO projection_thread_details (session_id, event_count, latest_event_sequence, latest_event_at,
          latest_turn_id, latest_turn_status, pending_approval_count, payload, updated_at) VALUES (?, 0, 0, NULL, NULL, NULL, 0, ?, ?)`,
          [session.id, JSON.stringify(detail), session.updatedAt]);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
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
      const runtimeSummary = sessionRuntimeSummaries(this.data.turns).get(sessionId);
      updated = sessionWithRuntimeSummary(
        updater(
          sessionWithRuntimeSummary(
            this.data.sessions[index]!,
            runtimeSummary
          )
        ),
        runtimeSummary
      );
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
      this.data.turns.push(turn);
      await this.rebuildLatestTurnProjectionForSession(turn.sessionId);
      await this.rebuildThreadDetailProjectionForSession(turn.sessionId);
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
      // The canonical turn row is committed at this point. Publish it to the
      // in-memory lifecycle view before rebuilding secondary projections so a
      // managed child can observe terminal completion without waiting for
      // unrelated provider cleanup or projection work.
      this.data.turns[index] = updated;
      await this.rebuildLatestTurnProjectionForSession(previousSessionId);
      if (updated.sessionId !== previousSessionId) await this.rebuildLatestTurnProjectionForSession(updated.sessionId);
      await this.rebuildThreadDetailProjectionForSession(previousSessionId);
      if (updated.sessionId !== previousSessionId) await this.rebuildThreadDetailProjectionForSession(updated.sessionId);
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
    return readCache<T>(this.home, type, key, { allowStale: true });
  }

  async getCacheEntriesByType<T>(type: string): Promise<Record<string, CacheEntry<T>>> {
    await this.ready;
    return listCache<T>(this.home, type);
  }

  async setCacheEntry<T>(type: string, key: string, payload: T, error: string | null = null): Promise<CacheEntry<T>> {
    await this.ready;
    return writeCache(this.home, type, key, payload, { error });
  }

  async setCacheError(type: string, key: string, fallbackPayload: unknown, error: string): Promise<void> {
    const existing = await this.getCacheEntry<unknown>(type, key);
    await this.setCacheEntry(type, key, existing?.payload ?? fallbackPayload, error);
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

  async appendRuntimeEvent(runtimeEvent: StoreData["events"][number]): Promise<RuntimeEvent> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const safeRuntimeEvent = sanitizeRuntimeEvent(runtimeEvent);
      await this.exec("BEGIN IMMEDIATE");
      try {
        const persistedRuntimeEvent = await this.insertRuntimeEventRecord(safeRuntimeEvent);
        const sessionIndex = this.data.sessions.findIndex((session) => session.id === persistedRuntimeEvent.sessionId);
        const currentSession = this.data.sessions[sessionIndex];
        const session = currentSession ? sessionWithSidebarActivity(currentSession, persistedRuntimeEvent) : null;
        if (session && session !== currentSession) {
          await this.run("UPDATE sessions SET payload = ? WHERE id = ?", [JSON.stringify(session), session.id]);
          await this.upsertSessionShellProjection(session, sessionIndex);
        }
        await this.exec("COMMIT");
        this.data.events.push(persistedRuntimeEvent);
        if (session && session !== currentSession) this.data.sessions[sessionIndex] = session;
        return persistedRuntimeEvent;
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.then(() => undefined, () => undefined);
    return await write;
  }

  private async insertRuntimeEventRecord(runtimeEvent: RuntimeEvent): Promise<RuntimeEvent> {
    const index = this.data.events.length;
    const sequence = await this.nextEventSequence();
    const persistedRuntimeEvent = { ...runtimeEvent, sequence };
    await this.run(
      "INSERT INTO events (id, session_id, turn_id, name, timestamp, sequence, sort_index, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        runtimeEvent.id,
        runtimeEvent.sessionId ?? null,
        runtimeEvent.turnId ?? null,
        runtimeEvent.name,
        runtimeEvent.timestamp,
        sequence,
        index,
        JSON.stringify(persistedRuntimeEvent),
      ],
    );
    if (runtimeEvent.sessionId) {
      await this.updateThreadDetailProjectionForEvent(persistedRuntimeEvent, sequence);
    }
    return persistedRuntimeEvent;
  }

  async runtimeEventContext(
    sessionId: string,
    providerTurnId?: string | null
  ): Promise<{ appId?: string | null; turnId?: string | null; }> {
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


}
