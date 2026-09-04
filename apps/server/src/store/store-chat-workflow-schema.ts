export async function createChatWorkflowTables(
  exec: (sql: string) => Promise<void>,
): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS chat_workflows (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      next_run_at TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS chat_workflows_session_idx
      ON chat_workflows(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS chat_workflows_due_idx
      ON chat_workflows(enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS chat_workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS chat_workflow_runs_occurrence_idx
      ON chat_workflow_runs(workflow_id, scheduled_for, trigger);
    CREATE INDEX IF NOT EXISTS chat_workflow_runs_workflow_idx
      ON chat_workflow_runs(workflow_id, created_at DESC);
  `);
}
