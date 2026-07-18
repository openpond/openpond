import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  nextCreateImproveRunRevision,
  type Approval,
  type InsightItem,
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

describe("SqliteStore hardening", () => {
  test("initializes fresh stores at the current schema version", async () => {
    await withStoreDir(async (storeDir) => {
      const store = new SqliteStore(storeDir);
      await store.snapshot();
      await store.close();

      expect(await userVersion(path.join(storeDir, "state.sqlite"))).toBe(CURRENT_SQLITE_SCHEMA_VERSION);
    });
  });

  test("atomically enforces one nonterminal current goal per session", async () => {
    await withStoreDir(async (storeDir) => {
      const store = new SqliteStore(storeDir);
      await store.snapshot();

      const starts = await Promise.allSettled([
        store.appendRuntimeEvent(threadGoalEvent("event-goal-1", "goal_1", "running")),
        store.appendRuntimeEvent(threadGoalEvent("event-goal-2-rejected", "goal_2", "queued")),
      ]);
      expect(starts[0]?.status).toBe("fulfilled");
      expect(starts[1]).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ message: expect.stringContaining("goal_1 is already running") }),
      });

      await expect(
        store.appendRuntimeEvent(threadGoalEvent("event-goal-1-paused", "goal_1", "paused")),
      ).resolves.toMatchObject({
        id: "event-goal-1-paused",
        sequence: 2,
      });
      await expect(
        store.claimOpenPondThreadGoal({
          sessionId: "session-goals",
          goalId: "goal_2",
          status: "queued",
          updatedAt: "2026-07-01T10:00:02.000Z",
        }),
      ).rejects.toThrow("goal_1 is already paused");

      await store.appendRuntimeEvent(threadGoalEvent("event-goal-1-completed", "goal_1", "completed"));
      await expect(
        store.appendRuntimeEvent(threadGoalEvent("event-goal-2", "goal_2", "running")),
      ).resolves.toMatchObject({
        id: "event-goal-2",
        sequence: 4,
      });
      await store.appendRuntimeEvent(threadGoalEvent("event-goal-2-completed", "goal_2", "completed"));

      await store.claimOpenPondThreadGoal({
        sessionId: "session-goals",
        goalId: "goal_3",
        status: "queued",
        updatedAt: "2026-07-01T10:00:05.000Z",
      });
      await store.releaseOpenPondThreadGoalClaim("session-goals", "goal_3");

      const eventIds = (await store.snapshot()).events.map((event) => event.id);
      expect(eventIds).toEqual([
        "event-goal-1",
        "event-goal-1-paused",
        "event-goal-1-completed",
        "event-goal-2",
        "event-goal-2-completed",
      ]);
      await store.close();

      const db = openTestDatabase(path.join(storeDir, "state.sqlite"));
      try {
        const rows = await all<OpenPondThreadGoalTestRow>(db, "SELECT * FROM openpond_thread_goals");
        expect(rows).toEqual([]);
      } finally {
        await close(db);
      }
    });
  });

  test("backfills the current goal claim when migrating an existing event store", async () => {
    await withStoreDir(async (storeDir) => {
      const storePath = path.join(storeDir, "state.sqlite");
      const initialStore = new SqliteStore(storeDir);
      await initialStore.appendRuntimeEvent(threadGoalEvent("event-existing-goal", "goal_existing", "running"));
      await initialStore.close();

      const db = openTestDatabase(storePath);
      await run(db, "DROP TABLE openpond_thread_goals");
      await run(db, "PRAGMA user_version = 9");
      await close(db);

      const migratedStore = new SqliteStore(storeDir);
      await migratedStore.snapshot();
      await expect(
        migratedStore.claimOpenPondThreadGoal({
          sessionId: "session-goals",
          goalId: "goal_new",
          status: "queued",
          updatedAt: "2026-07-01T10:01:00.000Z",
        }),
      ).rejects.toThrow("goal_existing is already running");
      await migratedStore.close();
      expect(await userVersion(storePath)).toBe(CURRENT_SQLITE_SCHEMA_VERSION);
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
        const insightTables = await all<{ name: string }>(
          db,
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name = 'insight_items'`,
        );
        expect(insightTables.map((row) => row.name)).toEqual(["insight_items"]);
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

  test("persists and patches insight rows", async () => {
    await withStoreDir(async (storeDir) => {
      const store = new SqliteStore(storeDir);
      const item = insightItem("insight-one", "active");
      await store.upsertInsightItem(item);
      await expect(store.listInsights({ status: "active" })).resolves.toMatchObject([
        {
          id: "insight-one",
          status: "active",
          payload: {
            detector: "test",
            createPipelineId: "create_pipeline_1",
          },
        },
      ]);

      const updated = await store.patchInsightStatus("insight-one", "resolved");
      expect(updated?.status).toBe("resolved");
      expect(updated?.resolvedAt).toBeTruthy();
      await expect(store.listInsights({ status: "active" })).resolves.toEqual([]);
      await expect(store.listInsights({ status: "resolved" })).resolves.toMatchObject([
        { id: "insight-one", status: "resolved" },
      ]);

      await store.close();

      const db = openTestDatabase(path.join(storeDir, "state.sqlite"));
      try {
        const row = await get<{ count: number }>(
          db,
          "SELECT COUNT(*) AS count FROM insight_items WHERE id = 'insight-one' AND status = 'resolved'",
        );
        expect(row.count).toBe(1);
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

type OpenPondThreadGoalTestRow = {
  session_id: string;
  goal_id: string;
  status: string;
  provisional: number;
  updated_at: string;
};

function threadGoalEvent(id: string, goalId: string, status: string): RuntimeEvent {
  return {
    id,
    sessionId: "session-goals",
    turnId: "turn-goals",
    name: "diagnostic",
    timestamp: "2026-07-01T10:00:00.000Z",
    source: "provider",
    status: "completed",
    output: goalId,
    data: {
      kind: "thread_goal",
      provider: "openpond",
      goal: {
        id: goalId,
        provider: "openpond",
        objective: `Objective for ${goalId}`,
        status,
        updatedAt: "2026-07-01T10:00:00.000Z",
      },
    },
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

function insightItem(id: string, status: InsightItem["status"]): InsightItem {
  return {
    id,
    scopeType: "session",
    scopeId: "session-insights",
    severity: "concern",
    type: "create_edit.awaiting_plan_approval",
    status,
    fingerprint: `fingerprint:${id}`,
    title: "Create agent is waiting for plan approval",
    summary: "Review the generated plan.",
    payload: {
      detector: "test",
      createPipelineId: "create_pipeline_1",
    },
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    resolvedAt: status === "resolved" ? "2026-07-01T10:00:00.000Z" : null,
    dismissedAt: status === "dismissed" ? "2026-07-01T10:00:00.000Z" : null,
  };
}
