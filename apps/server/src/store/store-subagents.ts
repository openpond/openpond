import { SubagentMessageSchema, SubagentRunSchema, type SubagentMessage, type SubagentRun } from "@openpond/contracts/subagents";
import type { PayloadRow } from "../types.js";
import { now } from "../utils.js";
import { openNodeSqliteConnection } from "./sqlite/sqlite-driver-node.js";
import { subagentMessageFromRow, subagentMessageParams, subagentRunFromRow, subagentRunParams } from "./store-codecs.js";
import { SqliteStoreDomain } from "./store-domain.js";

type SubagentRunRow = PayloadRow & {
  id: string;
  parent_session_id: string;
  parent_turn_id: string | null;
  child_session_id: string | null;
  role_id: string;
  status: SubagentRun["status"];
  created_at: string;
  updated_at: string;
};

type SubagentRunScopeRow = { parent_session_id: string; };

type SubagentMessageRow = PayloadRow & {
  id: string;
  from_run_id: string;
  to_run_id: string | null;
  to_role: string | null;
  kind: SubagentMessage["kind"];
  created_at: string;
};

const NON_TERMINAL_SUBAGENT_STATUSES: readonly SubagentRun["status"][] = [
  "queued",
  "running",
  "needs_resume",
];

export class SqliteSubagentStore extends SqliteStoreDomain {


  async getPersistedSubagentRun(id: string): Promise<SubagentRun | null> {
    await this.ready;
    const row = await this.persistedLifecycleRow<SubagentRunRow>(
      "SELECT * FROM subagent_runs WHERE id = ?",
      [id],
    );
    return row ? subagentRunFromRow(row) : null;
  }

  async upsertPersistedSubagentRun(run: SubagentRun): Promise<SubagentRun> {
    await this.ready;
    const parsed = SubagentRunSchema.parse(run);
    const updatedAt = now();
    const database = openNodeSqliteConnection(this.storePath);
    try {
      database.run(
        `INSERT INTO subagent_runs (
           id,
           parent_session_id,
           parent_turn_id,
           child_session_id,
           role_id,
           status,
           payload,
           created_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id)
         DO UPDATE SET
           parent_session_id = excluded.parent_session_id,
           parent_turn_id = excluded.parent_turn_id,
           child_session_id = excluded.child_session_id,
           role_id = excluded.role_id,
           status = excluded.status,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        subagentRunParams(parsed, updatedAt),
      );
    } finally {
      database.close();
    }
    return parsed;
  }

  private async persistedLifecycleRow<Row>(sql: string, params: unknown[]): Promise<Row | null> {
    const database = openNodeSqliteConnection(this.storePath);
    try {
      return database.get<Row>(sql, params);
    } finally {
      database.close();
    }
  }


  async upsertSubagentRun(run: SubagentRun): Promise<SubagentRun> {
    await this.ready;
    const parsed = SubagentRunSchema.parse(run);
    const updatedAt = now();
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO subagent_runs (
           id,
           parent_session_id,
           parent_turn_id,
           child_session_id,
           role_id,
           status,
           payload,
           created_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id)
         DO UPDATE SET
           parent_session_id = excluded.parent_session_id,
           parent_turn_id = excluded.parent_turn_id,
           child_session_id = excluded.child_session_id,
           role_id = excluded.role_id,
           status = excluded.status,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        subagentRunParams(parsed, updatedAt),
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    // The upsert already committed the exact parsed payload. Returning it
    // directly avoids joining writes that were queued afterward; one of those
    // writes may itself depend on this lifecycle transition and otherwise form
    // a queue cycle during child finalization.
    return parsed;
  }

  async recordRetainedWorkspaceExpiryWarning(
    runId: string,
    warning: Record<string, unknown>,
  ): Promise<SubagentRun | null> {
    await this.ready;
    let updated: SubagentRun | null = null;
    const write = this.writeQueue.then(async () => {
      const row = await this.get<SubagentRunRow>("SELECT * FROM subagent_runs WHERE id = ?", [runId]);
      if (!row) return;
      const current = subagentRunFromRow(row);
      updated = SubagentRunSchema.parse({
        ...current,
        metadata: {
          ...(current.metadata ?? {}),
          retainedWorkspaceExpiryWarning: warning,
        },
      });
      await this.run(
        `UPDATE subagent_runs
         SET payload = ?
         WHERE id = ?`,
        [JSON.stringify(updated), runId],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async getSubagentRun(id: string): Promise<SubagentRun | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<SubagentRunRow>("SELECT * FROM subagent_runs WHERE id = ?", [id]);
    return row ? subagentRunFromRow(row) : null;
  }

  async listSubagentRuns(query: {
    parentSessionId?: string | null;
    childSessionId?: string | null;
    status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
    limit?: number;
  } = {}): Promise<SubagentRun[]> {
    await this.ready;
    await this.writeQueue;
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.parentSessionId) {
      where.push("parent_session_id = ?");
      params.push(query.parentSessionId);
    }
    if (query.childSessionId) {
      where.push("child_session_id = ?");
      params.push(query.childSessionId);
    }
    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      if (statuses.length === 1) {
        where.push("status = ?");
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        params.push(...statuses);
      }
    }
    const limitSql = query.limit === undefined ? "" : "LIMIT ?";
    if (query.limit !== undefined) params.push(Math.max(1, Math.min(1000, Math.trunc(query.limit))));
    const rows = await this.all<SubagentRunRow>(
      `SELECT * FROM subagent_runs
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY updated_at DESC, created_at DESC
       ${limitSql}`,
      params,
    );
    return rows.map(subagentRunFromRow);
  }

  async listActiveSubagentRuns(query: {
    parentSessionId?: string | null;
    childSessionId?: string | null;
    status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
    limit?: number;
  } = {}): Promise<SubagentRun[]> {
    return this.listSubagentRuns({
      ...query,
      status: query.status ?? NON_TERMINAL_SUBAGENT_STATUSES,
    });
  }

  async listSubagentRunScopes(query: {
    status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
    updatedAtFrom?: string | null;
    limit?: number;
  } = {}): Promise<Array<{ parentSessionId: string; }>> {
    await this.ready;
    await this.writeQueue;
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      if (statuses.length === 1) {
        where.push("status = ?");
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        params.push(...statuses);
      }
    }
    if (query.updatedAtFrom) {
      where.push("updated_at >= ?");
      params.push(query.updatedAtFrom);
    }
    const limitSql = query.limit === undefined ? "" : "LIMIT ?";
    if (query.limit !== undefined) params.push(Math.max(1, Math.min(1000, Math.trunc(query.limit))));
    const rows = await this.all<SubagentRunScopeRow>(
      `SELECT parent_session_id
       FROM subagent_runs
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       GROUP BY parent_session_id
       ORDER BY MAX(updated_at) DESC
       ${limitSql}`,
      params,
    );
    return rows.map((row) => ({ parentSessionId: row.parent_session_id }));
  }

  async listStaleSubagentRuns(query: {
    olderThanMs: number;
    nowIso?: string | null;
    parentSessionId?: string | null;
    childSessionId?: string | null;
    status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
    limit?: number;
  }): Promise<SubagentRun[]> {
    await this.ready;
    await this.writeQueue;
    const nowMs = Date.parse(query.nowIso ?? now());
    const cutoff = new Date(nowMs - Math.max(0, Math.trunc(query.olderThanMs))).toISOString();
    const where: string[] = ["updated_at <= ?"];
    const params: unknown[] = [cutoff];
    if (query.parentSessionId) {
      where.push("parent_session_id = ?");
      params.push(query.parentSessionId);
    }
    if (query.childSessionId) {
      where.push("child_session_id = ?");
      params.push(query.childSessionId);
    }
    const statuses = query.status
      ? Array.isArray(query.status)
        ? query.status
        : [query.status]
      : NON_TERMINAL_SUBAGENT_STATUSES;
    if (statuses.length === 1) {
      where.push("status = ?");
      params.push(statuses[0]);
    } else if (statuses.length > 1) {
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    const limitSql = query.limit === undefined ? "" : "LIMIT ?";
    if (query.limit !== undefined) params.push(Math.max(1, Math.min(1000, Math.trunc(query.limit))));
    const rows = await this.all<SubagentRunRow>(
      `SELECT * FROM subagent_runs
       WHERE ${where.join(" AND ")}
       ORDER BY updated_at ASC, created_at ASC
       ${limitSql}`,
      params,
    );
    return rows.map(subagentRunFromRow);
  }

  async appendSubagentMessage(message: SubagentMessage): Promise<SubagentMessage> {
    await this.ready;
    const parsed = SubagentMessageSchema.parse(message);
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO subagent_messages (
           id,
           from_run_id,
           to_run_id,
           to_role,
           kind,
           payload,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        subagentMessageParams(parsed),
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return parsed;
  }

  async listSubagentMessages(query: {
    fromRunId?: string | null;
    toRunId?: string | null;
    toRole?: string | null;
    limit?: number;
  } = {}): Promise<SubagentMessage[]> {
    await this.ready;
    await this.writeQueue;
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.fromRunId) {
      where.push("from_run_id = ?");
      params.push(query.fromRunId);
    }
    if (query.toRunId) {
      where.push("to_run_id = ?");
      params.push(query.toRunId);
    }
    if (query.toRole) {
      where.push("to_role = ?");
      params.push(query.toRole);
    }
    const limitSql = query.limit === undefined ? "" : "LIMIT ?";
    if (query.limit !== undefined) params.push(Math.max(1, Math.min(1000, Math.trunc(query.limit))));
    const rows = await this.all<SubagentMessageRow>(
      `SELECT * FROM subagent_messages
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at ASC
       ${limitSql}`,
      params,
    );
    return rows.map(subagentMessageFromRow);
  }
}
