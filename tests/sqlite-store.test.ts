import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  SubagentMessageSchema,
  SubagentRunSchema,
  nextCreateImproveRunRevision,
  type Approval,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "@openpond/contracts";
import { CURRENT_SQLITE_SCHEMA_VERSION, SqliteStore } from "../apps/server/src/store/store";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";
import {
  allTestSql as all,
  closeTestDatabase as close,
  getTestSql as get,
  openTestDatabase,
  runTestSql as run,
} from "./helpers/sqlite-database";

async function userVersion(filePath: string): Promise<number> {
  const db = openTestDatabase(filePath);
  try {
    const row = await get<{ user_version: number }>(db, "PRAGMA user_version");
    return row.user_version;
  } finally {
    await close(db);
  }
}

async function withStoreDir(fn: (storeDir: string) => Promise<void>): Promise<void> {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-store-test-"));
  try {
    await fn(storeDir);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
}

function sqliteBusyError(): Error & { code: string } {
  return Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });
}

class TransientBusySqliteStore extends SqliteStore {
  static remainingFailures = 0;

  protected override async assertHealthyDatabase(): Promise<void> {
    if (TransientBusySqliteStore.remainingFailures > 0) {
      TransientBusySqliteStore.remainingFailures -= 1;
      throw sqliteBusyError();
    }
    return super.assertHealthyDatabase();
  }
}

class AlwaysBusySqliteStore extends SqliteStore {
  protected override async assertHealthyDatabase(): Promise<void> {
    throw sqliteBusyError();
  }
}

describe("SqliteStore hardening", () => {
  test("initializes fresh stores at the current schema version", async () => {
    await withStoreDir(async (storeDir) => {
      const store = new SqliteStore(storeDir);
      await store.snapshot();
      await store.close();

      expect(await userVersion(path.join(storeDir, "state.sqlite"))).toBe(CURRENT_SQLITE_SCHEMA_VERSION);
    });
  });

  test("splits legacy Model build drafts into stable Models and run drafts", async () => {
    await withStoreDir(async (storeDir) => {
      const storePath = path.join(storeDir, "state.sqlite");
      const store = new SqliteStore(storeDir);
      await store.snapshot();
      await store.close();

      const db = openTestDatabase(storePath);
      await run(db, "DROP TABLE model_projects");
      await run(db, "DROP TABLE model_run_drafts");
      await run(
        db,
        `CREATE TABLE model_build_drafts (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          status TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
      );
      const timestamp = "2026-07-23T12:00:00.000Z";
      await run(
        db,
        `INSERT INTO model_build_drafts
          (id, profile_id, model_id, status, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          "legacy_draft",
          "default",
          "legacy_model",
          "draft",
          JSON.stringify({
            schemaVersion: "openpond.modelBuildDraft.v1",
            id: "legacy_draft",
            profileId: "default",
            modelId: "legacy_model",
            status: "draft",
            name: "Legacy Model",
            objective: "Keep this setup",
            datasetMode: null,
            tasksetRef: null,
            datasetCreationId: null,
            buildIntent: "demonstration",
            buildSpecification: null,
            baseModel: null,
            method: "sft",
            destinationId: null,
            runPreset: "small",
            recipe: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
          timestamp,
          timestamp,
        ],
      );
      await run(db, "PRAGMA user_version = 29");
      await close(db);

      const migrated = new SqliteStore(storeDir);
      await migrated.snapshot();
      await migrated.close();

      const migratedDb = openTestDatabase(storePath);
      try {
        const projectTable = await get<{ name: string }>(
          migratedDb,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_projects'",
        );
        const draftTable = await get<{ name: string }>(
          migratedDb,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_run_drafts'",
        );
        expect(projectTable.name).toBe("model_projects");
        expect(draftTable.name).toBe("model_run_drafts");
        const project = await get<{ payload: string }>(
          migratedDb,
          "SELECT payload FROM model_projects WHERE id = 'legacy_model'",
        );
        const draft = await get<{ payload: string }>(
          migratedDb,
          "SELECT payload FROM model_run_drafts WHERE id = 'legacy_draft'",
        );
        expect(JSON.parse(project.payload)).toMatchObject({
          schemaVersion: "openpond.modelProject.v1",
          id: "legacy_model",
          name: "Legacy Model",
        });
        expect(JSON.parse(draft.payload)).toMatchObject({
          schemaVersion: "openpond.modelRunDraft.v1",
          id: "legacy_draft",
          modelId: "legacy_model",
          method: "sft",
        });
        expect(await userVersion(storePath)).toBe(CURRENT_SQLITE_SCHEMA_VERSION);
      } finally {
        await close(migratedDb);
      }
    });
  });

  test("clears replaced subagent transport rows and events during migration", async () => {
    await withStoreDir(async (storeDir) => {
      const storePath = path.join(storeDir, "state.sqlite");
      const store = new SqliteStore(storeDir);
      await store.upsertSubagentRun(SubagentRunSchema.parse({
        id: "legacy-subagent-run",
        parentSessionId: "session-parent",
        roleId: "coding",
        objective: "Old lifecycle work",
        createdAt: "2026-07-15T13:00:00.000Z",
      }));
      await store.appendRuntimeEvent({
        id: "legacy-subagent-event",
        sessionId: "session-parent",
        turnId: "turn-parent",
        name: "subagent.progress",
        timestamp: "2026-07-15T13:00:00.000Z",
        source: "server",
        status: "pending",
        output: "Old lifecycle update",
      });
      await store.close();

      const db = openTestDatabase(storePath);
      await run(db, "ALTER TABLE subagent_messages ADD COLUMN parent_goal_id TEXT");
      await run(
        db,
        `INSERT INTO subagent_messages (
           id, parent_goal_id, from_run_id, to_run_id, to_role, kind, payload, created_at
         ) VALUES (
           'legacy-message', 'goal-parent', 'legacy-subagent-run', NULL, NULL, 'status', '{}',
           '2026-07-15T13:00:01.000Z'
         )`,
      );
      await run(db, "PRAGMA user_version = 17");
      await close(db);

      const migrated = new SqliteStore(storeDir);
      await expect(migrated.listSubagentRuns()).resolves.toEqual([]);
      await migrated.close();

      const migratedDb = openTestDatabase(storePath);
      try {
        const counts = await get<{ runs: number; messages: number; events: number }>(
          migratedDb,
          `SELECT
             (SELECT COUNT(*) FROM subagent_runs) AS runs,
             (SELECT COUNT(*) FROM subagent_messages) AS messages,
             (SELECT COUNT(*) FROM events WHERE name LIKE 'subagent.%') AS events`,
        );
        expect(counts).toEqual({ runs: 0, messages: 0, events: 0 });
        expect(await userVersion(storePath)).toBe(CURRENT_SQLITE_SCHEMA_VERSION);
      } finally {
        await close(migratedDb);
      }
    });
  });

  test("retires Goal and Insights storage while preserving parent-scoped subagents", async () => {
    await withStoreDir(async (storeDir) => {
      const storePath = path.join(storeDir, "state.sqlite");
      const store = new SqliteStore(storeDir);
      await store.upsertSubagentRun(SubagentRunSchema.parse({
        id: "subagent-run-v32",
        parentSessionId: "session-parent",
        roleId: "coding",
        objective: "Keep this lifecycle work",
        createdAt: "2026-07-27T13:00:00.000Z",
      }));
      await store.appendSubagentMessage(SubagentMessageSchema.parse({
        id: "subagent-message-v32",
        fromRunId: "subagent-run-v32",
        kind: "status",
        body: "Keep this lifecycle message",
        createdAt: "2026-07-27T13:00:01.000Z",
      }));
      await store.setCacheEntry("local.projects", "v1", [
        { id: "project-keep", name: "Keep" },
        {
          id: "system_openpond_insights",
          name: "OpenPond Insights",
          systemKind: "openpond.insights",
        },
      ]);
      await store.close();

      const db = openTestDatabase(storePath);
      await run(db, "ALTER TABLE subagent_runs ADD COLUMN parent_goal_id TEXT");
      await run(db, "ALTER TABLE subagent_messages ADD COLUMN parent_goal_id TEXT");
      const runRow = await get<{ payload: string }>(
        db,
        "SELECT payload FROM subagent_runs WHERE id = 'subagent-run-v32'",
      );
      const messageRow = await get<{ payload: string }>(
        db,
        "SELECT payload FROM subagent_messages WHERE id = 'subagent-message-v32'",
      );
      await run(
        db,
        `UPDATE subagent_runs
         SET parent_goal_id = ?, payload = ?
         WHERE id = 'subagent-run-v32'`,
        [
          "goal-parent",
          JSON.stringify({
            ...JSON.parse(runRow.payload),
            parentGoalId: "goal-parent",
            peerMessages: "goal_scoped",
          }),
        ],
      );
      await run(
        db,
        `UPDATE subagent_messages
         SET parent_goal_id = ?, payload = ?
         WHERE id = 'subagent-message-v32'`,
        [
          "goal-parent",
          JSON.stringify({
            ...JSON.parse(messageRow.payload),
            parentGoalId: "goal-parent",
          }),
        ],
      );
      await run(
        db,
        `CREATE TABLE openpond_thread_goals (
          session_id TEXT PRIMARY KEY,
          goal_id TEXT,
          status TEXT,
          provisional INTEGER,
          updated_at TEXT
        )`,
      );
      await run(db, "CREATE TABLE insight_items (id TEXT PRIMARY KEY)");
      await run(
        db,
        `INSERT INTO sessions (id, sort_index, payload, updated_at)
         VALUES (?, ?, ?, ?)`,
        [
          "insights-session",
          0,
          JSON.stringify({
            ...session("insights-session"),
            systemKind: "openpond.insights",
            hiddenFromDefaultSidebar: true,
          }),
          "2026-07-27T13:00:00.000Z",
        ],
      );
      await run(
        db,
        `INSERT INTO projection_session_shells (id, sort_index, payload, updated_at)
         VALUES (?, ?, ?, ?)`,
        [
          "insights-session",
          0,
          JSON.stringify(session("insights-session")),
          "2026-07-27T13:00:00.000Z",
        ],
      );
      await run(
        db,
        `INSERT INTO projection_thread_details (
           session_id, event_count, latest_event_sequence, latest_event_at,
           latest_turn_id, latest_turn_status, pending_approval_count, payload, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "insights-session",
          0,
          0,
          null,
          null,
          null,
          0,
          "{}",
          "2026-07-27T13:00:00.000Z",
        ],
      );
      await run(
        db,
        `INSERT INTO projection_approvals (
           id, session_id, status, sort_index, payload, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          "insights-approval",
          "insights-session",
          "pending",
          0,
          "{}",
          "2026-07-27T13:00:00.000Z",
        ],
      );
      await run(
        db,
        `INSERT INTO projection_latest_turns (
           session_id, turn_id, status, sort_index, payload, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          "insights-session",
          "insights-turn",
          "completed",
          0,
          "{}",
          "2026-07-27T13:00:00.000Z",
        ],
      );
      await run(
        db,
        `INSERT INTO subagent_runs (
           id, parent_session_id, parent_turn_id, parent_goal_id, child_session_id,
           role_id, status, payload, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "insights-subagent-run",
          "insights-session",
          null,
          "goal-insights",
          null,
          "coding",
          "queued",
          JSON.stringify({
            ...JSON.parse(runRow.payload),
            id: "insights-subagent-run",
            parentSessionId: "insights-session",
            parentGoalId: "goal-insights",
          }),
          "2026-07-27T13:00:00.000Z",
          "2026-07-27T13:00:00.000Z",
        ],
      );
      await run(
        db,
        `INSERT INTO subagent_messages (
           id, parent_goal_id, from_run_id, to_run_id, to_role, kind, payload, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "insights-subagent-message",
          "goal-insights",
          "insights-subagent-run",
          null,
          null,
          "status",
          JSON.stringify({
            ...JSON.parse(messageRow.payload),
            id: "insights-subagent-message",
            fromRunId: "insights-subagent-run",
            parentGoalId: "goal-insights",
          }),
          "2026-07-27T13:00:01.000Z",
        ],
      );
      await run(
        db,
        `INSERT INTO model_usage_records (
           id, request_id, request_ordinal, session_id, provider, model, route,
           source, request_kind, visibility, status, started_at, attribution_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "legacy-insights-usage",
          "legacy-insights-request",
          1,
          "insights-session",
          "openpond",
          "openpond-chat",
          "byok",
          "insights",
          "insights_scan",
          "internal",
          "completed",
          "2026-07-27T13:00:00.000Z",
          "{}",
        ],
      );
      await run(db, "PRAGMA user_version = 32");
      await close(db);

      const migrated = new SqliteStore(storeDir);
      const snapshot = await migrated.snapshot();
      expect(snapshot.sessions.map((item) => item.id)).not.toContain("insights-session");
      await expect(migrated.listSubagentRuns()).resolves.toMatchObject([
        {
          id: "subagent-run-v32",
          peerMessages: "parent_scoped",
        },
      ]);
      await expect(migrated.listSubagentMessages()).resolves.toMatchObject([
        {
          id: "subagent-message-v32",
          body: "Keep this lifecycle message",
        },
      ]);
      await expect(migrated.listModelUsageRecords()).resolves.toEqual([]);
      await expect(migrated.getCacheEntry<Array<{ id: string }>>("local.projects", "v1"))
        .resolves.toMatchObject({
          payload: [{ id: "project-keep" }],
        });
      await migrated.close();

      const migratedDb = openTestDatabase(storePath);
      try {
        const retiredTables = await all<{ name: string }>(
          migratedDb,
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name IN ('openpond_thread_goals', 'insight_items')`,
        );
        expect(retiredTables).toEqual([]);
        const staleInsightRows = await get<{
          shells: number;
          details: number;
          approvals: number;
          turns: number;
        }>(
          migratedDb,
          `SELECT
             (SELECT COUNT(*) FROM projection_session_shells
              WHERE id = 'insights-session') AS shells,
             (SELECT COUNT(*) FROM projection_thread_details
              WHERE session_id = 'insights-session') AS details,
             (SELECT COUNT(*) FROM projection_approvals
              WHERE session_id = 'insights-session') AS approvals,
             (SELECT COUNT(*) FROM projection_latest_turns
              WHERE session_id = 'insights-session') AS turns`,
        );
        expect(staleInsightRows).toEqual({
          shells: 0,
          details: 0,
          approvals: 0,
          turns: 0,
        });
        const migratedRun = await get<{ payload: string }>(
          migratedDb,
          "SELECT payload FROM subagent_runs WHERE id = 'subagent-run-v32'",
        );
        const migratedMessage = await get<{ payload: string }>(
          migratedDb,
          "SELECT payload FROM subagent_messages WHERE id = 'subagent-message-v32'",
        );
        expect(JSON.parse(migratedRun.payload)).not.toHaveProperty("parentGoalId");
        expect(JSON.parse(migratedRun.payload)).toMatchObject({
          peerMessages: "parent_scoped",
        });
        expect(JSON.parse(migratedMessage.payload)).not.toHaveProperty("parentGoalId");
        expect(await userVersion(storePath)).toBe(CURRENT_SQLITE_SCHEMA_VERSION);
      } finally {
        await close(migratedDb);
      }
    });
  });

  test("creates Taskset revision storage for databases already migrated past training v11", async () => {
    await withStoreDir(async (storeDir) => {
      const storePath = path.join(storeDir, "state.sqlite");
      const initialStore = new SqliteStore(storeDir);
      await initialStore.snapshot();
      await initialStore.close();

      const db = openTestDatabase(storePath);
      await run(db, "DROP TABLE taskset_revisions");
      await run(db, "PRAGMA user_version = 20");
      await close(db);

      const migratedStore = new SqliteStore(storeDir);
      await migratedStore.snapshot();
      await migratedStore.close();

      const migratedDb = openTestDatabase(storePath);
      try {
        const table = await get<{ name: string }>(
          migratedDb,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'taskset_revisions'",
        );
        expect(table.name).toBe("taskset_revisions");
      } finally {
        await close(migratedDb);
      }
      expect(await userVersion(storePath)).toBe(CURRENT_SQLITE_SCHEMA_VERSION);
    });
  });

  test("backs up an existing unversioned database before migrating", async () => {
    await withStoreDir(async (storeDir) => {
      const storePath = path.join(storeDir, "state.sqlite");
      const db = openTestDatabase(storePath);
      await run(db, "CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY)");
      await close(db);

      const store = new SqliteStore(storeDir);
      await store.snapshot();
      await store.close();

      expect(await userVersion(storePath)).toBe(CURRENT_SQLITE_SCHEMA_VERSION);
      const backups = await readdir(path.join(storeDir, "backups"));
      expect(backups.length).toBe(1);
    });
  });

  test("moves corrupt database files aside and starts fresh", async () => {
    await withStoreDir(async (storeDir) => {
      const storePath = path.join(storeDir, "state.sqlite");
      await writeFile(storePath, "not a sqlite database", "utf8");

      const store = new SqliteStore(storeDir);
      await store.snapshot();
      await store.close();

      expect(await userVersion(storePath)).toBe(CURRENT_SQLITE_SCHEMA_VERSION);
      const corruptFiles = await readdir(path.join(storeDir, "corrupt"));
      expect(corruptFiles.some((file) => file.includes("quick-check-failed") && file.endsWith(".sqlite"))).toBe(true);
    });
  });

  test("retries transient busy health checks without quarantining a healthy database", async () => {
    await withStoreDir(async (storeDir) => {
      const initial = new SqliteStore(storeDir);
      await initial.mutate((data) => {
        data.sessions.push(session("session-preserved-after-busy"));
      });
      await initial.close();

      TransientBusySqliteStore.remainingFailures = 2;
      const reopened = new TransientBusySqliteStore(storeDir);
      await expect(reopened.getSession("session-preserved-after-busy")).resolves.toMatchObject({
        id: "session-preserved-after-busy",
      });
      await reopened.close();

      const corruptFiles = await readdir(path.join(storeDir, "corrupt")).catch(() => []);
      expect(corruptFiles).toEqual([]);
    });
  });

  test("preserves database files when transient busy health checks exhaust retries", async () => {
    await withStoreDir(async (storeDir) => {
      const storePath = path.join(storeDir, "state.sqlite");
      const initial = new SqliteStore(storeDir);
      await initial.mutate((data) => {
        data.sessions.push(session("session-preserved-after-exhausted-busy"));
      });
      await initial.close();

      const busy = new AlwaysBusySqliteStore(storeDir);
      await expect(busy.snapshot()).rejects.toThrow("database is locked");

      const corruptFiles = await readdir(path.join(storeDir, "corrupt")).catch(() => []);
      expect(corruptFiles).toEqual([]);
      const db = openTestDatabase(storePath);
      try {
        const rows = await all<{ id: string }>(db, "SELECT id FROM sessions WHERE id = ?", [
          "session-preserved-after-exhausted-busy",
        ]);
        expect(rows).toEqual([{ id: "session-preserved-after-exhausted-busy" }]);
      } finally {
        await close(db);
      }
    });
  });

  test("does not classify a database open failure as corruption", async () => {
    await withStoreDir(async (storeDir) => {
      let attempts = 0;
      class TransientOpenFailureStore extends SqliteStore {
        protected override async openDatabase(filename: string) {
          attempts += 1;
          if (attempts < 3) throw new Error("database is temporarily busy");
          return super.openDatabase(filename);
        }
      }

      const store = new TransientOpenFailureStore(storeDir);
      await store.snapshot();
      await store.close();

      expect(attempts).toBe(3);
      expect(await readdir(storeDir)).not.toContain("corrupt");
      expect(await userVersion(path.join(storeDir, "state.sqlite"))).toBe(
        CURRENT_SQLITE_SCHEMA_VERSION,
      );
    });
  });

  test("uses indexed helpers for event pages, pending approvals, sessions, and turn lookup", async () => {
    await withStoreDir(async (storeDir) => {
      const store = new SqliteStore(storeDir);
      const sessions = [session("session-a"), session("session-b")];
      const turns = [
        turn("turn-a1", "session-a", "provider-a1", "completed"),
        turn("turn-a2", "session-a", null, "in_progress"),
        turn("turn-b1", "session-b", "provider-b1", "completed"),
      ];
      const events = [
        runtimeEvent("event-a1", "session-a", "turn-a1"),
        runtimeEvent("event-b1", "session-b", "turn-b1"),
        runtimeEvent("event-a2", "session-a", "turn-a2"),
        runtimeEvent("event-a3", "session-a", "turn-a2"),
      ];
      const approvals = [
        approval("approval-a", "session-a", "pending"),
        approval("approval-b", "session-b", "accepted"),
        approval("approval-c", "session-a", "pending"),
      ];

      await store.mutate((data) => {
        data.sessions.push(...sessions);
        data.turns.push(...turns);
        data.events.push(...events);
        data.approvals.push(...approvals);
      });

      await expect(store.getSession("session-a")).resolves.toMatchObject({ id: "session-a" });
      await expect(store.turnByProviderTurnId("provider-b1")).resolves.toMatchObject({ id: "turn-b1" });
      await expect(store.latestTurnForSession("session-a", "in_progress")).resolves.toMatchObject({ id: "turn-a2" });
      await expect(store.pendingApprovals()).resolves.toEqual([
        approvals[0],
        approvals[2],
      ]);

      const page = await store.runtimeEventPageRows({
        sessionId: "session-a",
        afterSequence: 1,
        beforeSequence: null,
        limit: 10,
      });
      expect(page.entries.map((entry) => [entry.sequence, entry.event.id])).toEqual([
        [3, "event-a2"],
        [4, "event-a3"],
      ]);
      expect(page.entries.map((entry) => entry.event.sequence)).toEqual([3, 4]);
      expect(page.totalMatchingEvents).toBe(3);
      expect(page.remainingMatchingEvents).toBe(2);
      const previousPage = await store.runtimeEventPageRows({
        sessionId: "session-a",
        afterSequence: 0,
        beforeSequence: 4,
        limit: 1,
      });
      expect(previousPage.entries.map((entry) => [entry.sequence, entry.event.id])).toEqual([
        [3, "event-a2"],
      ]);
      expect(previousPage.remainingMatchingEvents).toBe(2);
      await expect(store.latestEventSequence()).resolves.toBe(4);
      await expect(store.threadDetailProjection("session-a")).resolves.toMatchObject({
        sessionId: "session-a",
        eventCount: 3,
        latestEventSequence: 4,
        latestTurnId: "turn-a2",
        latestTurnStatus: "in_progress",
        pendingApprovalCount: 2,
      });

      await store.close();

      const db = openTestDatabase(path.join(storeDir, "state.sqlite"));
      try {
        const rows = await all<{ name: string }>(
          db,
          `SELECT name FROM sqlite_master
           WHERE type = 'index'
             AND name IN (
               'turns_session_sort_idx',
               'turns_session_status_sort_idx',
               'turns_provider_turn_id_idx',
               'events_session_sort_idx',
               'events_sequence_idx',
               'events_session_sequence_idx',
               'approvals_status_sort_idx'
             )
           ORDER BY name`,
        );
        expect(rows.map((row) => row.name)).toEqual([
          "approvals_status_sort_idx",
          "events_sequence_idx",
          "events_session_sequence_idx",
          "events_session_sort_idx",
          "turns_provider_turn_id_idx",
          "turns_session_sort_idx",
          "turns_session_status_sort_idx",
        ]);
        const projectionTables = await all<{ name: string }>(
          db,
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name IN (
               'projection_session_shells',
               'projection_thread_details',
               'projection_approvals',
               'projection_latest_turns'
             )
           ORDER BY name`,
        );
        expect(projectionTables.map((row) => row.name)).toEqual([
          "projection_approvals",
          "projection_latest_turns",
          "projection_session_shells",
          "projection_thread_details",
        ]);
        const retiredTables = await all<{ name: string }>(
          db,
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name IN ('openpond_thread_goals', 'insight_items')`,
        );
        expect(retiredTables).toEqual([]);
      } finally {
        await close(db);
      }
    });
  });

  test("persists targeted session, turn, and approval writes without full-store mutation", async () => {
    await withStoreDir(async (storeDir) => {
      const store = new SqliteStore(storeDir);
      const olderSession = session("session-older");
      const newerSession = { ...session("session-newer"), order: 1 };

      await store.insertSessionAtFront(olderSession);
      await store.insertSessionAtFront(newerSession);
      expect(await store.sessionCount()).toBe(2);
      expect((await store.snapshot()).sessions.map((item) => item.id)).toEqual([
        "session-newer",
        "session-older",
      ]);

      const renamedSession = await store.updateSession("session-older", (current) => ({
        ...current,
        title: "Renamed session",
        updatedAt: "2026-07-01T10:05:00.000Z",
      }));
      expect(renamedSession?.title).toBe("Renamed session");
      await expect(store.getSession("session-older")).resolves.toMatchObject({
        title: "Renamed session",
      });
      const batchUpdated = await store.updateSessionsWhere(
        (candidate) => candidate.id.startsWith("session-"),
        (candidate) => ({
          ...candidate,
          archived: true,
          updatedAt: "2026-07-01T10:05:30.000Z",
        }),
      );
      expect(batchUpdated.map((item) => item.id).sort()).toEqual([
        "session-newer",
        "session-older",
      ]);
      expect((await store.snapshot()).sessions.every((item) => item.archived)).toBe(true);

      const firstTurn = turn("turn-targeted", "session-older", null, "in_progress");
      await store.insertTurn(firstTurn);
      const completedTurn = await store.updateTurn("turn-targeted", (current) => ({
        ...current,
        providerTurnId: "provider-targeted",
        status: "completed",
        completedAt: "2026-07-01T10:06:00.000Z",
      }));
      expect(completedTurn).toMatchObject({
        id: "turn-targeted",
        providerTurnId: "provider-targeted",
        status: "completed",
      });
      await expect(store.turnByProviderTurnId("provider-targeted")).resolves.toMatchObject({
        id: "turn-targeted",
      });

      const pending = approval("approval-targeted", "session-older", "pending");
      await store.upsertApproval(pending);
      await expect(store.pendingApprovals()).resolves.toEqual([pending]);
      await expect(store.threadDetailProjection("session-older")).resolves.toMatchObject({
        latestTurnId: "turn-targeted",
        latestTurnStatus: "completed",
        pendingApprovalCount: 1,
      });
      const accepted = { ...pending, status: "accepted" as const };
      await store.upsertApproval(accepted);
      await expect(store.getApproval("approval-targeted")).resolves.toEqual(accepted);
      await expect(store.pendingApprovals()).resolves.toEqual([]);
      await expect(store.latestTurnForSession("session-older")).resolves.toMatchObject({
        id: "turn-targeted",
        status: "completed",
      });
      await expect(store.threadDetailProjection("session-older")).resolves.toMatchObject({
        latestTurnId: "turn-targeted",
        latestTurnStatus: "completed",
        pendingApprovalCount: 0,
      });

      await store.close();

      const db = openTestDatabase(path.join(storeDir, "state.sqlite"));
      try {
        const counts = await get<{ sessions: number; turns: number; approvals: number }>(
          db,
          `SELECT
             (SELECT COUNT(*) FROM sessions) AS sessions,
             (SELECT COUNT(*) FROM turns) AS turns,
             (SELECT COUNT(*) FROM approvals) AS approvals`,
        );
        expect(counts).toEqual({ sessions: 2, turns: 1, approvals: 1 });
      } finally {
        await close(db);
      }
    });
  });

  test("returns a committed subagent upsert without joining later queued reads", async () => {
    await withStoreDir(async (storeDir) => {
      const store = new SqliteStore(storeDir);
      const run = SubagentRunSchema.parse({
        id: "run-finalizing",
        parentSessionId: "session-parent",
        roleId: "coding",
        objective: "Submit the completed child handoff",
        required: true,
        createdAt: "2026-07-15T13:00:00.000Z",
      });
      (store as any).getSubagentRun = async () => new Promise<never>(() => undefined);

      await expect(Promise.race([
        store.upsertSubagentRun(run),
        new Promise((_, reject) => setTimeout(() => reject(new Error("upsert joined a later read")), 500)),
      ])).resolves.toMatchObject({ id: run.id });

      await store.close();
    });
  });

  test("compacts large runtime event output on targeted append", async () => {
    await withStoreDir(async (storeDir) => {
      const store = new SqliteStore(storeDir);
      const largeOutput = `${"A".repeat(25_000)}middle-content-should-be-omitted${"Z".repeat(25_000)}`;

      await store.appendRuntimeEvent({
        id: "large-command-output",
        sessionId: "session-large",
        turnId: "turn-large",
        name: "command.output",
        timestamp: "2026-07-01T10:00:00.000Z",
        source: "provider",
        action: "exec_command",
        output: largeOutput,
        data: { callId: "call-large" },
      });

      const event = (await store.snapshot()).events[0]!;
      expect(event.output?.length).toBeLessThan(largeOutput.length);
      expect(event.output?.startsWith("A".repeat(1_000))).toBe(true);
      expect(event.output?.endsWith("Z".repeat(1_000))).toBe(true);
      expect(event.output).toContain("[openpond event output compacted:");
      expect(event.output).not.toContain("middle-content-should-be-omitted");
      expect(event.data).toMatchObject({
        callId: "call-large",
        outputCompaction: {
          schemaVersion: "openpond.runtimeEventOutputCompaction.v1",
          reason: "large_output",
          originalChars: largeOutput.length,
        },
      });
      await expect(store.latestEventSequence()).resolves.toBe(1);
      await expect(store.threadDetailProjection("session-large")).resolves.toMatchObject({
        eventCount: 1,
        latestEventSequence: 1,
        latestEventAt: "2026-07-01T10:00:00.000Z",
      });

      await store.close();

      const db = openTestDatabase(path.join(storeDir, "state.sqlite"));
      try {
        const row = await get<{ payload: string; sequence: number }>(
          db,
          "SELECT payload, sequence FROM events WHERE id = 'large-command-output'",
        );
        const persisted = JSON.parse(row.payload) as RuntimeEvent;
        expect(row.sequence).toBe(1);
        expect(persisted.output).toBe(event.output);
        expect(persisted.data).toEqual(event.data);
      } finally {
        await close(db);
      }
    });
  });

  test("persists indexed Create/Improve runs with CAS, idempotent actions, and one active run per target", async () => {
    await withStoreDir(async (storeDir) => {
      const store = new SqliteStore(storeDir);
      const run = createImproveRunFixture({
        id: "create_improve_store",
        state: "awaiting_plan_approval",
        scope: {
          profileId: "default",
          conversationId: "session-create-improve",
          originTurnId: "turn-create-improve",
          workItemId: null,
          projectId: null,
          targetProject: null,
        },
      });
      await store.upsertCreateImproveRun(run);

      await expect(store.getCreateImproveRun(run.id)).resolves.toEqual(run);
      await expect(store.listCreateImproveRuns({
        profileId: "default",
        targetKind: "agent",
        targetId: run.target.id,
      })).resolves.toEqual([run]);

      const action = {
        runId: run.id,
        expectedRevision: run.revision,
        actionId: "approve_create_improve_store",
        type: "approve_plan" as const,
      };
      const first = await store.mutateCreateImproveRun(action, (current) =>
        nextCreateImproveRunRevision(current, {
          state: "applying_source",
          plan: current.plan ? {
            ...current.plan,
            status: "approved",
            approvedAt: "2026-07-01T10:01:00.000Z",
            updatedAt: "2026-07-01T10:01:00.000Z",
          } : null,
          updatedAt: "2026-07-01T10:01:00.000Z",
        }, action.actionId));
      expect(first).toMatchObject({
        replayed: false,
        run: { revision: 1, state: "applying_source" },
      });

      const replay = await store.mutateCreateImproveRun(action, () => {
        throw new Error("idempotent replay must not call the updater");
      });
      expect(replay).toEqual({ run: first.run, replayed: true });

      await expect(store.mutateCreateImproveRun({
        ...action,
        actionId: "stale_create_improve_store",
      }, (current) => current)).rejects.toThrow("changed from revision 0 to 1");

      await expect(store.upsertCreateImproveRun(createImproveRunFixture({
        id: "create_improve_competing",
        target: run.target,
        scope: run.scope,
      }))).rejects.toThrow(`already has active Create/Improve run ${run.id}`);

      const blocked = nextCreateImproveRunRevision(first.run, {
        state: "blocked",
        blockedReason: "Planner output could not be applied.",
        updatedAt: "2026-07-01T10:02:00.000Z",
      });
      await store.upsertCreateImproveRun(blocked);
      await expect(store.upsertCreateImproveRun(createImproveRunFixture({
        id: "create_improve_retry",
        target: run.target,
        scope: run.scope,
      }))).resolves.toMatchObject({
        id: "create_improve_retry",
        state: "planning",
      });

      await store.close();
    });
  });
});

function session(id: string): Session {
  return {
    id,
    provider: "openpond",
    modelRef: null,
    title: id,
    appId: null,
    appName: null,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/tmp/openpond",
    codexThreadId: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}

function turn(
  id: string,
  sessionId: string,
  providerTurnId: string | null,
  status: Turn["status"],
): Turn {
  return {
    id,
    sessionId,
    providerTurnId,
    modelRef: { providerId: "openpond", modelId: "openpond-chat" },
    prompt: id,
    startedAt: "2026-07-01T10:00:00.000Z",
    completedAt: status === "in_progress" ? null : "2026-07-01T10:00:01.000Z",
    status,
    error: null,
    metadata: {},
    createImproveRun: null,
  };
}

function runtimeEvent(id: string, sessionId: string, turnId: string): RuntimeEvent {
  return {
    id,
    sessionId,
    turnId,
    name: "assistant.delta",
    timestamp: "2026-07-01T10:00:00.000Z",
    source: "provider",
    status: "running",
    output: id,
  };
}

function approval(id: string, sessionId: string, status: Approval["status"]): Approval {
  return {
    id,
    sessionId,
    turnId: null,
    providerRequestId: null,
    kind: "command",
    title: id,
    detail: id,
    status,
    createdAt: "2026-07-01T10:00:00.000Z",
  };
}
