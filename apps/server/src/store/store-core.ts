import { promises as fs } from "node:fs";
import path from "node:path";
import type { Approval, RuntimeEvent, Session, Turn } from "@openpond/contracts";
import type { Logger } from "@openpond/logging";
import type { PayloadRow, StoreData } from "../types.js";
import { now } from "../utils.js";
import { CURRENT_SQLITE_SCHEMA_VERSION, SQLITE_CREATE_SCHEMA_SQL } from "./store-schema.js";
import { normalizeSessionPayload, persistStoreData, readStoreData } from "./store-persistence.js";
import {
  createCreateImproveRunTables,
  createFireworksModelServingSessionTables,
  createGraderAuditTables,
  createTaskAttemptArtifactTables,
  createTaskCreationProjectionTables,
  createTasksetRevisionTables,
  createTrainingReceiptAndModelBindingTables,
  deduplicateFireworksMetricArtifacts,
} from "./store-continuous-improvement-schema.js";
import { createDatasetImportTables as ensureDatasetImportTables } from "./store-dataset-schema.js";
import { createSidebarFileBookmarkTables as ensureSidebarFileBookmarkTables } from "./store-sidebar-file-bookmark-schema.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { openNodeSqliteConnection } from "./sqlite/sqlite-driver-node.js";
import {
  isConfirmedSqliteCorruption,
  retrySqliteHealthCheck,
  SqliteIntegrityError,
} from "./sqlite/sqlite-health.js";
import {
  threadDetailProjectionFromRow,
  threadDetailProjectionPayload,
  timestampForPath,
  type ThreadDetailProjection,
  type ThreadDetailProjectionRow,
} from "./store-codecs.js";
import { SQLITE_MIGRATIONS } from "./store-migrations.js";
import {
  resetLegacySubagentRuntimeEvents as resetLegacySubagentRuntimeEventsMigration,
  resetLegacySubagentTransportState as resetLegacySubagentTransportStateMigration,
} from "./store-subagent-migrations.js";
import {
  createModelProjectAndRunDraftTables as migrateModelProjectAndRunDraftTables,
} from "./store-model-run-migration.js";
import {
  createModelLifecycleTables as migrateModelLifecycleTables,
} from "./store-model-lifecycle-migration.js";
import { TRAINING_TABLES_SQL } from "./store-training-base-schema.js";

type UserVersionRow = { user_version: number };
type QuickCheckRow = { quick_check: string };
type TableInfoRow = { name: string };

const SQLITE_OPEN_RETRY_DELAYS_MS = [0, 100, 250, 500] as const;

export type SqliteStoreCoreOptions = {
  logger?: Logger;
};

export class SqliteStoreCore {
  readonly storePath: string;
  protected data: StoreData = { sessions: [], turns: [], events: [], approvals: [] };
  protected ready: Promise<void>;
  protected db: OpenPondSqliteConnection | null = null;
  protected writeQueue: Promise<void> = Promise.resolve();
  protected readonly logger?: Logger;

  constructor(storeDir: string, options: SqliteStoreCoreOptions = {}) {
    this.storePath = path.join(storeDir, "state.sqlite");
    this.logger = options.logger;
    this.ready = this.load(storeDir);
  }

  async recentTurns(limit = 2_000): Promise<Turn[]> {
    await this.ready;
    await this.writeQueue;
    const boundedLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
    const rows = await this.all<PayloadRow>(
      "SELECT payload FROM turns ORDER BY sort_index DESC LIMIT ?",
      [boundedLimit],
    );
    return rows.map((row) => JSON.parse(row.payload) as Turn).reverse();
  }

  protected async load(storeDir: string): Promise<void> {
    await fs.mkdir(storeDir, { recursive: true });
    const hadDatabase = await this.fileExists(this.storePath);
    await this.openDatabaseWithRecovery(storeDir);
    await this.runMigrations(storeDir, hadDatabase);
    this.data = await readStoreData({
      allPayloadRows: (sql, params) => this.all<PayloadRow>(sql, params),
    });
  }

  protected async configureDatabase(): Promise<void> {
    await this.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
    `);
  }

  protected async assertHealthyDatabase(): Promise<void> {
    const rows = await this.all<QuickCheckRow>("PRAGMA quick_check");
    const failures = rows.map((row) => row.quick_check).filter((value) => value !== "ok");
    if (failures.length > 0) {
      throw new SqliteIntegrityError(`SQLite quick_check failed: ${failures.join("; ")}`);
    }
  }

  protected async assertHealthyDatabaseWithRetry(): Promise<void> {
    await retrySqliteHealthCheck({
      check: () => this.assertHealthyDatabase(),
      onRetry: ({ attempt, retryDelayMs, error }) => {
        this.logger?.warn("sqlite health check temporarily unavailable; retrying", {
          storePath: this.storePath,
          attempt,
          retryDelayMs,
          error,
        });
      },
    });
  }

  protected async runMigrations(storeDir: string, hadDatabase: boolean): Promise<void> {
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

  protected async userVersion(): Promise<number> {
    const row = await this.get<UserVersionRow>("PRAGMA user_version", []);
    return row?.user_version ?? 0;
  }

  protected async openDatabaseWithRecovery(storeDir: string): Promise<void> {
    try {
      this.db = await this.openDatabaseWithRetry();
    } catch (error) {
      if (!isConfirmedSqliteCorruption(error)) {
        this.logger?.error("sqlite open failed without confirmed corruption; preserving database files", {
          storePath: this.storePath,
          error,
        });
        throw error;
      }
      this.logger?.error("sqlite open confirmed corruption; moving database files aside", {
        storePath: this.storePath,
        error,
      });
      await this.moveDatabaseFilesAside(storeDir, "open-failed");
      this.db = await this.openDatabaseWithRetry();
    }

    try {
      await this.configureDatabase();
      await this.assertHealthyDatabaseWithRetry();
    } catch (error) {
      await this.closeDatabaseHandle();
      if (!isConfirmedSqliteCorruption(error)) {
        this.logger?.error("sqlite health check failed without confirmed corruption; preserving database files", {
          storePath: this.storePath,
          error,
        });
        throw error;
      }
      this.logger?.error("sqlite health check confirmed corruption; moving database files aside", {
        storePath: this.storePath,
        error,
      });
      await this.moveDatabaseFilesAside(storeDir, "quick-check-failed");
      this.db = await this.openDatabaseWithRetry();
      await this.configureDatabase();
      await this.assertHealthyDatabaseWithRetry();
    }
  }

  protected async openDatabaseWithRetry(): Promise<OpenPondSqliteConnection> {
    let lastError: unknown = null;
    for (const delayMs of SQLITE_OPEN_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        return await this.openDatabase(this.storePath);
      } catch (error) {
        lastError = error;
      }
    }
    this.logger?.error("sqlite open failed; preserving database files", {
      storePath: this.storePath,
      attempts: SQLITE_OPEN_RETRY_DELAYS_MS.length,
      error: lastError,
    });
    throw lastError;
  }

  protected async backupDatabaseFiles(storeDir: string, label: string): Promise<void> {
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

  protected async moveDatabaseFilesAside(storeDir: string, reason: string): Promise<void> {
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

  protected databaseFiles(): string[] {
    return [this.storePath, `${this.storePath}-wal`, `${this.storePath}-shm`];
  }

  protected async fileExists(filePath: string): Promise<boolean> {
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

  async createSidebarFileBookmarkTables(): Promise<void> {
    await ensureSidebarFileBookmarkTables((sql) => this.exec(sql));
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

  async createModelUsageTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS model_usage_records (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        request_ordinal INTEGER NOT NULL,
        session_id TEXT,
        turn_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        route TEXT NOT NULL,
        source TEXT NOT NULL,
        request_kind TEXT NOT NULL,
        visibility TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        first_token_ms INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        error_type TEXT,
        error_message TEXT,
        attribution_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS model_usage_started_at_idx
        ON model_usage_records(started_at);

      CREATE INDEX IF NOT EXISTS model_usage_provider_model_started_idx
        ON model_usage_records(provider, model, started_at);

      CREATE INDEX IF NOT EXISTS model_usage_session_turn_ordinal_idx
        ON model_usage_records(session_id, turn_id, request_ordinal);

      CREATE INDEX IF NOT EXISTS model_usage_request_kind_started_idx
        ON model_usage_records(request_kind, started_at);

      CREATE INDEX IF NOT EXISTS model_usage_visibility_started_idx
        ON model_usage_records(visibility, started_at);

      CREATE INDEX IF NOT EXISTS model_usage_status_started_idx
        ON model_usage_records(status, started_at);
    `);
  }

  async createLocalAgentScheduleTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS local_agent_schedules (
        id TEXT PRIMARY KEY,
        local_project_id TEXT NOT NULL,
        schedule_name TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        next_run_at TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS local_agent_schedules_project_name_idx
        ON local_agent_schedules(local_project_id, schedule_name);

      CREATE INDEX IF NOT EXISTS local_agent_schedules_due_idx
        ON local_agent_schedules(enabled, next_run_at);

      CREATE TABLE IF NOT EXISTS local_agent_schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        local_project_id TEXT NOT NULL,
        schedule_name TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS local_agent_schedule_runs_schedule_time_idx
        ON local_agent_schedule_runs(schedule_id, scheduled_for, trigger);

      CREATE INDEX IF NOT EXISTS local_agent_schedule_runs_schedule_idx
        ON local_agent_schedule_runs(schedule_id, created_at DESC);
    `);
  }

  async createSubagentTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS subagent_runs (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        parent_turn_id TEXT,
        child_session_id TEXT,
        role_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS subagent_runs_parent_session_status_idx
        ON subagent_runs(parent_session_id, status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS subagent_runs_child_session_idx
        ON subagent_runs(child_session_id);

      CREATE TABLE IF NOT EXISTS subagent_messages (
        id TEXT PRIMARY KEY,
        from_run_id TEXT NOT NULL,
        to_run_id TEXT,
        to_role TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS subagent_messages_receiver_created_idx
        ON subagent_messages(to_run_id, to_role, created_at);
    `);
  }

  async retireGoalAndInsightsStorage(): Promise<void> {
    const sessionRows = await this.all<PayloadRow & { id: string }>(
      "SELECT id, payload FROM sessions",
    );
    const insightSessionIds = sessionRows.flatMap((row) => {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      return payload.systemKind === "openpond.insights" ? [row.id] : [];
    });
    const insightSessionIdSet = new Set(insightSessionIds);
    const runRows = (await this.all<PayloadRow & {
      id: string;
      parent_session_id: string;
      parent_turn_id: string | null;
      child_session_id: string | null;
      role_id: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>("SELECT * FROM subagent_runs")).filter(
      (row) =>
        !insightSessionIdSet.has(row.parent_session_id) &&
        (!row.child_session_id || !insightSessionIdSet.has(row.child_session_id)),
    );
    const retainedRunIds = new Set(runRows.map((row) => row.id));
    const messageRows = (await this.all<PayloadRow & {
      id: string;
      from_run_id: string;
      to_run_id: string | null;
      to_role: string | null;
      kind: string;
      created_at: string;
    }>("SELECT * FROM subagent_messages")).filter(
      (row) =>
        retainedRunIds.has(row.from_run_id) &&
        (!row.to_run_id || retainedRunIds.has(row.to_run_id)),
    );

    for (const sessionId of insightSessionIds) {
      await this.run("DELETE FROM model_usage_records WHERE session_id = ?", [sessionId]);
      await this.run("DELETE FROM projection_thread_details WHERE session_id = ?", [sessionId]);
      await this.run("DELETE FROM projection_session_shells WHERE id = ?", [sessionId]);
      await this.run("DELETE FROM projection_approvals WHERE session_id = ?", [sessionId]);
      await this.run("DELETE FROM projection_latest_turns WHERE session_id = ?", [sessionId]);
      await this.run("DELETE FROM approvals WHERE session_id = ?", [sessionId]);
      await this.run("DELETE FROM events WHERE session_id = ?", [sessionId]);
      await this.run("DELETE FROM turns WHERE session_id = ?", [sessionId]);
      await this.run("DELETE FROM sessions WHERE id = ?", [sessionId]);
    }
    await this.run(
      `DELETE FROM model_usage_records
       WHERE request_kind IN ('insights_scan', 'insights_question', 'goal_control')`,
      [],
    );

    const localProjects = await this.get<PayloadRow>(
      `SELECT payload FROM cache_entries
       WHERE type = 'local.projects' AND cache_key = 'v1'`,
      [],
    );
    if (localProjects) {
      const payload = JSON.parse(localProjects.payload) as unknown;
      if (Array.isArray(payload)) {
        const retainedProjects = payload.filter((project) => {
          if (!project || typeof project !== "object" || Array.isArray(project)) return true;
          const record = project as Record<string, unknown>;
          return record.id !== "system_openpond_insights" &&
            record.systemKind !== "openpond.insights";
        });
        await this.run(
          `UPDATE cache_entries SET payload = ?
           WHERE type = 'local.projects' AND cache_key = 'v1'`,
          [JSON.stringify(retainedProjects)],
        );
      }
    }

    await this.exec(`
      DROP TABLE IF EXISTS insight_items;
      DROP TABLE IF EXISTS openpond_thread_goals;
      DROP TABLE IF EXISTS subagent_messages;
      DROP TABLE IF EXISTS subagent_runs;
    `);
    await this.createSubagentTables();

    for (const row of runRows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      delete payload.parentGoalId;
      if (payload.peerMessages === "goal_scoped") payload.peerMessages = "parent_scoped";
      await this.run(
        `INSERT INTO subagent_runs (
           id, parent_session_id, parent_turn_id, child_session_id, role_id,
           status, payload, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.parent_session_id,
          row.parent_turn_id,
          row.child_session_id,
          row.role_id,
          row.status,
          JSON.stringify(payload),
          row.created_at,
          row.updated_at,
        ],
      );
    }
    for (const row of messageRows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      delete payload.parentGoalId;
      await this.run(
        `INSERT INTO subagent_messages (
           id, from_run_id, to_run_id, to_role, kind, payload, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.from_run_id,
          row.to_run_id,
          row.to_role,
          row.kind,
          JSON.stringify(payload),
          row.created_at,
        ],
      );
    }

    await this.run(
      `UPDATE cache_entries
       SET payload = replace(payload, '"goal_scoped"', '"parent_scoped"')
       WHERE instr(payload, '"goal_scoped"') > 0`,
      [],
    );
  }

  async resetLegacySubagentTransportState(): Promise<void> {
    await resetLegacySubagentTransportStateMigration((sql) => this.exec(sql));
  }

  async resetLegacySubagentRuntimeEvents(): Promise<void> {
    await resetLegacySubagentRuntimeEventsMigration(
      (sql, params) => this.run(sql, params),
      () => this.rebuildReadModels(),
    );
  }

  async createCreateImproveRunTables(): Promise<void> {
    await createCreateImproveRunTables((sql) => this.exec(sql));
  }

  async createTrainingTables(): Promise<void> {
    await this.exec(TRAINING_TABLES_SQL);
  }

  async createModelBuildDraftTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS model_build_drafts (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS model_build_drafts_profile_updated_idx
        ON model_build_drafts(profile_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS model_build_drafts_model_idx
        ON model_build_drafts(model_id, updated_at DESC);
    `);
  }

  async createModelProjectAndRunDraftTables(): Promise<void> {
    await migrateModelProjectAndRunDraftTables({
      all: <T>(sql: string, params: unknown[] = []) => this.all<T>(sql, params),
      exec: (sql) => this.exec(sql),
      run: (sql, params = []) => this.run(sql, params),
    });
  }

  async createModelLifecycleTables(): Promise<void> {
    await migrateModelLifecycleTables({
      exec: (sql) => this.exec(sql),
    });
  }

  async createDatasetImportTables(): Promise<void> {
    await ensureDatasetImportTables({
      all: <T>(sql: string, params: unknown[] = []) =>
        this.all<T>(sql, params),
      exec: (sql) => this.exec(sql),
    });
  }

  async createTasksetRevisionTables(): Promise<void> {
    await createTasksetRevisionTables((sql) => this.exec(sql));
  }

  async createTrainingReceiptAndModelBindingTables(): Promise<void> {
    await createTrainingReceiptAndModelBindingTables((sql) => this.exec(sql));
  }

  async createFireworksModelServingSessionTables(): Promise<void> {
    await createFireworksModelServingSessionTables((sql) => this.exec(sql));
  }

  async deduplicateFireworksMetricArtifacts(): Promise<void> {
    await deduplicateFireworksMetricArtifacts((sql) => this.exec(sql));
  }

  async createTaskCreationProjectionTables(): Promise<void> {
    await createTaskCreationProjectionTables((sql) => this.exec(sql));
  }

  async createGraderAuditTables(): Promise<void> {
    await createGraderAuditTables((sql) => this.exec(sql));
  }

  async createTaskAttemptArtifactTables(): Promise<void> {
    await createTaskAttemptArtifactTables((sql) => this.exec(sql));
  }

  async createTrainingChatSearchTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS training_chat_search_documents (
        session_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        signature TEXT NOT NULL,
        title TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        eligible INTEGER NOT NULL,
        body_indexed INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS training_chat_search_documents_source_idx
        ON training_chat_search_documents(source);
      CREATE VIRTUAL TABLE IF NOT EXISTS training_chat_search_fts USING fts5(
        session_id UNINDEXED,
        title,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  }

  async resetTrainingChatSearchForProgressiveIndexing(): Promise<void> {
    await this.addColumnIfMissing("training_chat_search_documents", "body_indexed", "INTEGER NOT NULL DEFAULT 1");
    await this.exec(`
      DROP TABLE IF EXISTS training_chat_search_fts;
      CREATE VIRTUAL TABLE training_chat_search_fts USING fts5(
        session_id UNINDEXED,
        title,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    await this.run("DELETE FROM training_chat_search_documents", []);
  }

  async createTaskMinerRunTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS task_miner_runs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_miner_runs_profile_updated_idx ON task_miner_runs(profile_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS task_miner_runs_status_updated_idx ON task_miner_runs(status, updated_at DESC);
    `);
  }

  protected async addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
    const rows = await this.all<TableInfoRow>(`PRAGMA table_info(${table})`);
    if (rows.some((row) => row.name === column)) return;
    await this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  protected async backfillTurnQueryColumns(): Promise<void> {
    const rows = await this.all<(PayloadRow & { id: string })>("SELECT id, payload FROM turns");
    for (const row of rows) {
      const turn = JSON.parse(row.payload) as Partial<Turn>;
      await this.run(
        "UPDATE turns SET provider_turn_id = ?, status = ? WHERE id = ?",
        [turn.providerTurnId ?? null, turn.status ?? null, row.id],
      );
    }
  }

  protected async nextEventSequence(): Promise<number> {
    const row = await this.get<{ sequence: number | null }>("SELECT MAX(sequence) AS sequence FROM events", []);
    return (row?.sequence ?? 0) + 1;
  }

  protected async upsertSessionShellProjection(session: Session, sortIndex: number): Promise<void> {
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

  protected async upsertApprovalProjection(approval: Approval, sortIndex: number): Promise<void> {
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

  protected async rebuildLatestTurnProjectionForSession(sessionId: string): Promise<void> {
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

  protected async rebuildThreadDetailProjectionForSession(sessionId: string): Promise<void> {
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

  protected async updateThreadDetailProjectionForEvent(event: RuntimeEvent, sequence: number): Promise<void> {
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

  protected async threadDetailProjectionFromDb(sessionId: string): Promise<ThreadDetailProjection | null> {
    const row = await this.get<ThreadDetailProjectionRow>(
      "SELECT * FROM projection_thread_details WHERE session_id = ?",
      [sessionId],
    );
    return row ? threadDetailProjectionFromRow(row) : null;
  }

  protected async rebuildReadModels(): Promise<void> {
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
      const session = normalizeSessionPayload(JSON.parse(row.payload));
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

  protected async persist(): Promise<void> {
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

  protected async closeDatabaseHandle(): Promise<void> {
    const db = this.db;
    this.db = null;
    if (!db) return;
    db.close();
  }

  protected async openDatabase(filename: string): Promise<OpenPondSqliteConnection> {
    return openNodeSqliteConnection(filename);
  }

  protected async exec(sql: string): Promise<void> {
    this.database.exec(sql);
  }

  protected async run(sql: string, params: unknown[]): Promise<void> {
    this.database.run(sql, params);
  }

  protected async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.database.all<T>(sql, params);
  }

  protected async get<T>(sql: string, params: unknown[]): Promise<T | null> {
    return this.database.get<T>(sql, params);
  }

  protected get database(): OpenPondSqliteConnection {
    if (!this.db) throw new Error("SQLite store is not ready");
    return this.db;
  }
}
