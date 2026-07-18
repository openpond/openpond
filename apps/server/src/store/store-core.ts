import { promises as fs } from "node:fs";
import path from "node:path";
import type { Approval, RuntimeEvent, Session, Turn } from "@openpond/contracts";
import type { Logger } from "@openpond/logging";
import type { PayloadRow, StoreData } from "../types.js";
import { now } from "../utils.js";
import { CURRENT_SQLITE_SCHEMA_VERSION, SQLITE_CREATE_SCHEMA_SQL } from "./store-schema.js";
import { normalizeSessionPayload, persistStoreData, readStoreData } from "./store-persistence.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { openNodeSqliteConnection } from "./sqlite/sqlite-driver-node.js";
import {
  isTerminalOpenPondGoalStatus,
  openPondThreadGoalMutationFromEvent,
  threadDetailProjectionFromRow,
  threadDetailProjectionPayload,
  timestampForPath,
  type EventPagePayloadRow,
  type OpenPondThreadGoalMutation,
  type ThreadDetailProjection,
  type ThreadDetailProjectionRow,
} from "./store-codecs.js";

type UserVersionRow = { user_version: number };
type QuickCheckRow = { quick_check: string };
type TableInfoRow = { name: string };

const SQLITE_OPEN_RETRY_DELAYS_MS = [0, 100, 250, 500] as const;

export type SqliteStoreCoreOptions = {
  logger?: Logger;
};

type Migration = {
  version: number;
  run: (store: SqliteStoreCore) => Promise<void>;
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
    await this.configureDatabase();
    await this.assertHealthyDatabase();
    await this.runMigrations(storeDir, hadDatabase);
    this.data = await readStoreData({
      allPayloadRows: (sql, params) => this.all<PayloadRow>(sql, params),
    });
    await this.run("DELETE FROM openpond_thread_goals WHERE provisional = 1", []);
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
      throw new Error(`SQLite quick_check failed: ${failures.join("; ")}`);
    }
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
    this.db = await this.openDatabaseWithRetry();

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
        parent_goal_id TEXT,
        child_session_id TEXT,
        role_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS subagent_runs_parent_session_status_idx
        ON subagent_runs(parent_session_id, status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS subagent_runs_parent_goal_status_idx
        ON subagent_runs(parent_goal_id, status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS subagent_runs_child_session_idx
        ON subagent_runs(child_session_id);

      CREATE TABLE IF NOT EXISTS subagent_messages (
        id TEXT PRIMARY KEY,
        parent_goal_id TEXT,
        from_run_id TEXT NOT NULL,
        to_run_id TEXT,
        to_role TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS subagent_messages_parent_goal_created_idx
        ON subagent_messages(parent_goal_id, created_at);

      CREATE INDEX IF NOT EXISTS subagent_messages_receiver_created_idx
        ON subagent_messages(to_run_id, to_role, created_at);
    `);
  }

  async createOpenPondThreadGoalTable(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS openpond_thread_goals (
        session_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        status TEXT NOT NULL,
        provisional INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
    const rows = await this.all<EventPagePayloadRow>(
      "SELECT sequence, payload FROM events ORDER BY sequence ASC",
      [],
    );
    const currentBySession = new Map<string, Extract<OpenPondThreadGoalMutation, { kind: "upsert" }>>();
    for (const row of rows) {
      const mutation = openPondThreadGoalMutationFromEvent(JSON.parse(row.payload) as RuntimeEvent);
      if (!mutation) continue;
      if (mutation.kind === "clear") {
        currentBySession.delete(mutation.sessionId);
      } else if (isTerminalOpenPondGoalStatus(mutation.status)) {
        if (currentBySession.get(mutation.sessionId)?.goalId === mutation.goalId) {
          currentBySession.delete(mutation.sessionId);
        }
      } else {
        currentBySession.set(mutation.sessionId, mutation);
      }
    }
    await this.run("DELETE FROM openpond_thread_goals", []);
    for (const goal of currentBySession.values()) {
      await this.run(
        `INSERT INTO openpond_thread_goals (session_id, goal_id, status, provisional, updated_at)
         VALUES (?, ?, ?, 0, ?)`,
        [goal.sessionId, goal.goalId, goal.status, goal.updatedAt],
      );
    }
  }

  async createCreateImproveRunTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS create_improve_runs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        conversation_id TEXT,
        origin_turn_id TEXT,
        target_kind TEXT NOT NULL,
        target_id TEXT,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS create_improve_runs_profile_state_updated_idx
        ON create_improve_runs(profile_id, state, updated_at DESC);
      CREATE INDEX IF NOT EXISTS create_improve_runs_conversation_updated_idx
        ON create_improve_runs(conversation_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS create_improve_runs_target_updated_idx
        ON create_improve_runs(profile_id, target_kind, target_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS create_improve_run_actions (
        action_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        expected_revision INTEGER NOT NULL,
        resulting_revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES create_improve_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS create_improve_run_actions_run_revision_idx
        ON create_improve_run_actions(run_id, resulting_revision);
    `);
  }

  async createTrainingTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS training_sources (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, session_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS training_sources_profile_updated_idx ON training_sources(profile_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS training_sources_session_idx ON training_sources(session_id);
      CREATE TABLE IF NOT EXISTS task_creation_snapshots (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_creation_profile_updated_idx ON task_creation_snapshots(profile_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS tasksets (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasksets_profile_status_updated_idx ON tasksets(profile_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS taskset_revisions (taskset_id TEXT NOT NULL, revision INTEGER NOT NULL, content_hash TEXT NOT NULL, profile_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(taskset_id, revision));
      CREATE UNIQUE INDEX IF NOT EXISTS taskset_revisions_hash_idx ON taskset_revisions(taskset_id, content_hash);
      CREATE TABLE IF NOT EXISTS task_candidates (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, status TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS task_candidates_profile_fingerprint_idx ON task_candidates(profile_id, fingerprint);
      CREATE INDEX IF NOT EXISTS task_candidates_profile_status_updated_idx ON task_candidates(profile_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS task_attempts (id TEXT PRIMARY KEY, taskset_id TEXT NOT NULL, split TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_attempts_taskset_split_idx ON task_attempts(taskset_id, split, created_at DESC);
      CREATE TABLE IF NOT EXISTS grade_results (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS grade_results_attempt_idx ON grade_results(attempt_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS baseline_reports (id TEXT PRIMARY KEY, taskset_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS baseline_reports_taskset_idx ON baseline_reports(taskset_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS readiness_reports (taskset_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_miner_configs (profile_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_miner_runs (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_miner_runs_profile_updated_idx ON task_miner_runs(profile_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS task_miner_runs_status_updated_idx ON task_miner_runs(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS training_plans (id TEXT PRIMARY KEY, taskset_id TEXT NOT NULL, destination_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS training_plans_taskset_idx ON training_plans(taskset_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS training_bundles (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, content_hash TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS training_bundles_content_hash_idx ON training_bundles(content_hash);
      CREATE TABLE IF NOT EXISTS training_jobs (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, destination_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS training_jobs_status_updated_idx ON training_jobs(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS training_jobs_plan_idx ON training_jobs(plan_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS training_approvals (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, bundle_hash TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS training_approvals_plan_idx ON training_approvals(plan_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS training_job_events (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(job_id, sequence));
      CREATE INDEX IF NOT EXISTS training_job_events_job_sequence_idx ON training_job_events(job_id, sequence);
      CREATE TABLE IF NOT EXISTS training_artifacts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS training_artifacts_job_kind_idx ON training_artifacts(job_id, kind, created_at DESC);
      CREATE TABLE IF NOT EXISTS model_artifact_lineage (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, taskset_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS model_lineage_artifact_idx ON model_artifact_lineage(artifact_id);
      CREATE INDEX IF NOT EXISTS model_lineage_taskset_idx ON model_artifact_lineage(taskset_id, created_at DESC);
    `);
  }

  async createTasksetRevisionTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS taskset_revisions (
        taskset_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(taskset_id, revision)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS taskset_revisions_hash_idx
        ON taskset_revisions(taskset_id, content_hash);
    `);
  }

  async createTrainingReceiptAndModelBindingTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS training_rollout_receipts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        taskset_id TEXT NOT NULL,
        provider_rollout_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS training_rollout_receipts_job_updated_idx
        ON training_rollout_receipts(job_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS training_rollout_receipts_taskset_updated_idx
        ON training_rollout_receipts(taskset_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS model_bindings (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        role TEXT NOT NULL,
        role_target_id TEXT NOT NULL,
        model_artifact_lineage_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS model_bindings_active_role_idx
        ON model_bindings(profile_id, role, role_target_id)
        WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS model_bindings_model_idx
        ON model_bindings(model_artifact_lineage_id, updated_at DESC);
    `);
  }

  async createFireworksModelServingSessionTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS fireworks_model_serving_sessions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        model_artifact_lineage_id TEXT NOT NULL,
        state TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fireworks_serving_profile_state_updated_idx
        ON fireworks_model_serving_sessions(profile_id, state, updated_at DESC);
      CREATE INDEX IF NOT EXISTS fireworks_serving_model_updated_idx
        ON fireworks_model_serving_sessions(model_artifact_lineage_id, updated_at DESC);
    `);
  }

  async deduplicateFireworksMetricArtifacts(): Promise<void> {
    await this.exec(`
      DELETE FROM training_artifacts AS older
      WHERE older.kind = 'metrics'
        AND json_extract(older.payload, '$.metadata.provider') = 'fireworks'
        AND EXISTS (
          SELECT 1
          FROM training_artifacts AS newer
          WHERE newer.kind = 'metrics'
            AND newer.job_id = older.job_id
            AND json_extract(newer.payload, '$.metadata.provider') = 'fireworks'
            AND COALESCE(
              json_extract(newer.payload, '$.metadata.metricSource'),
              ''
            ) = COALESCE(
              json_extract(older.payload, '$.metadata.metricSource'),
              ''
            )
            AND (
              newer.created_at > older.created_at
              OR (
                newer.created_at = older.created_at
                AND newer.id > older.id
              )
            )
        );
    `);
  }

  async createTaskCreationProjectionTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS task_creation_transcripts (creation_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_creation_transcript_profile_idx ON task_creation_transcripts(profile_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS task_design_proposals (creation_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, profile_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS task_design_proposal_id_idx ON task_design_proposals(proposal_id);
    `);
  }

  async createGraderAuditTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS grader_audit_reports (id TEXT PRIMARY KEY, taskset_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS grader_audit_taskset_idx ON grader_audit_reports(taskset_id, created_at DESC);
    `);
  }

  async createTaskAttemptArtifactTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS task_attempt_artifacts (id TEXT PRIMARY KEY, taskset_id TEXT NOT NULL, attempt_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_attempt_artifacts_attempt_idx ON task_attempt_artifacts(attempt_id, created_at);
      CREATE INDEX IF NOT EXISTS task_attempt_artifacts_taskset_idx ON task_attempt_artifacts(taskset_id, created_at);
    `);
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

  async createCrossSystemFrontierBaselineRunTables(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS cross_system_frontier_baseline_runs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cross_system_frontier_runs_profile_updated_idx ON cross_system_frontier_baseline_runs(profile_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS cross_system_frontier_runs_status_updated_idx ON cross_system_frontier_baseline_runs(status, updated_at DESC);
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
  {
    version: 7,
    run: (store) => store.createModelUsageTables(),
  },
  {
    version: 8,
    run: (store) => store.createLocalAgentScheduleTables(),
  },
  {
    version: 9,
    run: (store) => store.createSubagentTables(),
  },
  {
    version: 10,
    run: (store) => store.createOpenPondThreadGoalTable(),
  },
  {
    version: 11,
    run: (store) => store.createTrainingTables(),
  },
  {
    version: 12,
    run: (store) => store.createTaskCreationProjectionTables(),
  },
  {
    version: 13,
    run: (store) => store.createGraderAuditTables(),
  },
  {
    version: 14,
    run: (store) => store.createTaskAttemptArtifactTables(),
  },
  {
    version: 15,
    run: (store) => store.createTrainingChatSearchTables(),
  },
  {
    version: 16,
    run: (store) => store.resetTrainingChatSearchForProgressiveIndexing(),
  },
  {
    version: 17,
    run: (store) => store.createTaskMinerRunTables(),
  },
  {
    version: 18,
    run: (store) => store.createCrossSystemFrontierBaselineRunTables(),
  },
  {
    version: 19,
    run: (store) => store.createCreateImproveRunTables(),
  },
  {
    version: 20,
    run: (store) => store.createTrainingReceiptAndModelBindingTables(),
  },
  {
    version: 21,
    run: (store) => store.createTasksetRevisionTables(),
  },
  {
    version: 22,
    run: (store) => store.createFireworksModelServingSessionTables(),
  },
  {
    version: 23,
    run: (store) => store.deduplicateFireworksMetricArtifacts(),
  },
];
