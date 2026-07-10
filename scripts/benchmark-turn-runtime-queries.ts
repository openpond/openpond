import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sqlite3 from "sqlite3";
import { SqliteStore } from "../apps/server/src/store/store";

const EVENT_COUNT = 100_000;
const TARGET_SESSION_ID = "benchmark-target";
const TARGET_EVENT_INTERVAL = 10_000;

async function main(): Promise<void> {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-turn-query-benchmark-"));
  const store = new SqliteStore(storeDir);
  try {
    await store.latestEventSequence();
    const seedStarted = performance.now();
    await seedEvents(store.storePath);
    const seedMs = performance.now() - seedStarted;
    const heapBefore = process.memoryUsage().heapUsed;
    const preflightStarted = performance.now();
    const [events, currentGoal, latestAssistant, turnCount] = await Promise.all([
      store.runtimeEventsForSession(TARGET_SESSION_ID, { afterSequence: 50_000 }),
      store.currentOpenPondThreadGoal(TARGET_SESSION_ID),
      store.latestAssistantTextForSession(TARGET_SESSION_ID),
      store.countTurnsForSession(TARGET_SESSION_ID),
    ]);
    const preflightMs = performance.now() - preflightStarted;
    const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
    const report = {
      schema: "openpond.turn-runtime-query-benchmark.v1",
      eventCount: EVENT_COUNT,
      targetEventCount: EVENT_COUNT / TARGET_EVENT_INTERVAL,
      seedMs: rounded(seedMs),
      preflightMs: rounded(preflightMs),
      heapDeltaBytes,
      result: {
        events: events.length,
        currentGoalId: currentGoal?.id ?? null,
        latestAssistant,
        turnCount,
      },
      queryCount: 4,
    };
    console.log(JSON.stringify(report, null, 2));
    if (events.length !== 5 || currentGoal?.id !== "goal-benchmark" || latestAssistant !== "assistant-100000") {
      throw new Error("Focused query benchmark returned an unexpected result set.");
    }
  } finally {
    await store.close();
    await rm(storeDir, { recursive: true, force: true });
  }
}

async function seedEvents(filePath: string): Promise<void> {
  const db = await openDatabase(filePath);
  try {
    await exec(db, "BEGIN IMMEDIATE");
    const statement = await prepare(
      db,
      "INSERT INTO events (id, session_id, turn_id, name, timestamp, sequence, sort_index, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    try {
      for (let sequence = 1; sequence <= EVENT_COUNT; sequence += 1) {
        const target = sequence % TARGET_EVENT_INTERVAL === 0;
        const sessionId = target ? TARGET_SESSION_ID : `noise-${sequence % 100}`;
        const name = target && sequence === 90_000 ? "diagnostic" : "assistant.delta";
        const event = {
          id: `event-${sequence}`,
          sequence,
          sessionId,
          name,
          timestamp: "2026-07-10T00:00:00.000Z",
          source: "server",
          output: target ? `assistant-${sequence}` : "noise",
          ...(name === "diagnostic"
            ? {
                data: {
                  kind: "thread_goal",
                  goal: {
                    id: "goal-benchmark",
                    objective: "Benchmark focused goal lookup",
                    status: "running",
                    provider: "openpond",
                  },
                },
              }
            : {}),
        };
        await runStatement(statement, [
          event.id,
          sessionId,
          null,
          name,
          event.timestamp,
          sequence,
          sequence - 1,
          JSON.stringify(event),
        ]);
      }
    } finally {
      await finalize(statement);
    }
    await exec(db, "COMMIT");
    await exec(
      db,
      `INSERT INTO openpond_thread_goals (session_id, goal_id, status, updated_at)
       VALUES ('${TARGET_SESSION_ID}', 'goal-benchmark', 'running', '2026-07-10T00:00:00.000Z')`,
    );
  } catch (error) {
    await exec(db, "ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await closeDatabase(db);
  }
}

function openDatabase(filePath: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, (error) => (error ? reject(error) : resolve(db)));
  });
}

function exec(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => db.exec(sql, (error) => (error ? reject(error) : resolve())));
}

function prepare(db: sqlite3.Database, sql: string): Promise<sqlite3.Statement> {
  return new Promise((resolve, reject) => {
    const statement = db.prepare(sql, (error) => (error ? reject(error) : resolve(statement)));
  });
}

function runStatement(statement: sqlite3.Statement, values: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => statement.run(values, (error) => (error ? reject(error) : resolve())));
}

function finalize(statement: sqlite3.Statement): Promise<void> {
  return new Promise((resolve, reject) => statement.finalize((error) => (error ? reject(error) : resolve())));
}

function closeDatabase(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())));
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
