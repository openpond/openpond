import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../apps/server/src/store/store";
import { normalizeSqliteParameters } from "../apps/server/src/store/sqlite/sqlite-values";

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
  const db = new DatabaseSync(filePath, { timeout: 1_000 });
  try {
    db.exec("BEGIN IMMEDIATE");
    const statement = db.prepare(
      "INSERT INTO events (id, session_id, turn_id, name, timestamp, sequence, sort_index, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
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
      statement.run(...normalizeSqliteParameters([
        event.id,
        sessionId,
        null,
        name,
        event.timestamp,
        sequence,
        sequence - 1,
        JSON.stringify(event),
      ]));
    }
    db.exec("COMMIT");
    db.exec(
      `INSERT INTO openpond_thread_goals (session_id, goal_id, status, updated_at)
       VALUES ('${TARGET_SESSION_ID}', 'goal-benchmark', 'running', '2026-07-10T00:00:00.000Z')`,
    );
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may already be closed by SQLite after an error.
    }
    throw error;
  } finally {
    db.close();
  }
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
