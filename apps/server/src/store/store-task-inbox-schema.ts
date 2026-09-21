export const TASK_INBOX_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS task_inputs (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    sender_key TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    turn_id TEXT,
    payload TEXT NOT NULL,
    admission TEXT NOT NULL,
    UNIQUE(session_id, sender_key, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS task_inputs_pending_idx ON task_inputs(session_id, state, sequence);
  CREATE INDEX IF NOT EXISTS task_inputs_turn_idx ON task_inputs(turn_id, state);

  CREATE TABLE IF NOT EXISTS task_input_requests (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    input_ids TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_input_requests_turn_idx ON task_input_requests(turn_id);

  CREATE TABLE IF NOT EXISTS task_inbox_turns (
    session_id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    accepting INTEGER NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_work_claims (
    session_id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    work_areas TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_waits (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    target_session_id TEXT,
    target_turn_id TEXT,
    state TEXT NOT NULL,
    deadline TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_waits_session_idx ON task_waits(session_id, state);
  CREATE INDEX IF NOT EXISTS task_waits_target_idx ON task_waits(target_session_id, target_turn_id, state);

  CREATE TABLE IF NOT EXISTS task_completion_outbox (
    turn_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    input_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_completion_pending_idx ON task_completion_outbox(created_at) WHERE input_id IS NULL;
`;
