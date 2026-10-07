import { afterEach } from "vitest";
import type { Session, Turn } from "@openpond/contracts";
import { SqliteTaskInboxStore, type TaskInboxRepository } from "../../apps/server/src/store/store-task-inbox";
import { TASK_INBOX_SCHEMA_SQL } from "../../apps/server/src/store/store-task-inbox-schema";
import { NodeSqliteConnection } from "../../apps/server/src/store/sqlite/sqlite-driver-node";

const connections = new Set<NodeSqliteConnection>();
afterEach(() => { for (const db of connections) db.close(); connections.clear(); });

/** Existing turn fixtures keep their mocked provider/store. Inbox operations use the real SQL implementation. */
export function taskInboxTestStore(snapshot: () => Promise<{ turns: Turn[]; sessions?: Map<string, Session> }>): TaskInboxRepository & { sessionShells(): Promise<Session[]> } {
  const db = new NodeSqliteConnection(":memory:");
  connections.add(db);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, sort_index INTEGER NOT NULL);
    CREATE TABLE subagent_runs (id TEXT PRIMARY KEY, parent_session_id TEXT, parent_turn_id TEXT,
      child_session_id TEXT, role_id TEXT, status TEXT, payload TEXT, created_at TEXT, updated_at TEXT);`);
  db.exec(TASK_INBOX_SCHEMA_SQL);
  const sqlStore = new SqliteTaskInboxStore({
    home: ":memory:", storePath: ":memory:", logger: undefined, db, database: db,
    ready: Promise.resolve(), writeQueue: Promise.resolve(),
  });
  const methods: Record<string, unknown> = { sessionShells: async () => [] };
  for (const name of Object.getOwnPropertyNames(SqliteTaskInboxStore.prototype)) {
    if (name === "constructor" || name === "inboxWrite") continue;
    const method = (sqlStore as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]!;
    methods[name] = async (...args: unknown[]) => {
      const current = await snapshot();
      for (const session of current.sessions?.values() ?? []) db.run("INSERT INTO sessions VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload", [session.id, JSON.stringify(session)]);
      for (const [index, turn] of current.turns.entries()) db.run("INSERT INTO turns VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status", [turn.id, turn.sessionId, turn.status, index]);
      if (name === "admitTaskInput" || name === "admitTaskInputs") {
        const inputs = name === "admitTaskInputs" ? args[0] as Array<{ sessionId: string }> : [args[0] as { sessionId: string }];
        for (const input of inputs) db.run("INSERT OR IGNORE INTO sessions VALUES (?, ?)", [input.sessionId, JSON.stringify({ id: input.sessionId, status: "idle", archived: false })]);
      }
      return method.apply(sqlStore, args);
    };
  }
  return methods as TaskInboxRepository & { sessionShells(): Promise<Session[]> };
}
