export const CURRENT_SQLITE_SCHEMA_VERSION = 6;

export const SQLITE_CREATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    sort_index INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sort_index INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    turn_id TEXT,
    name TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    sort_index INTEGER NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS events_sequence_idx ON events(sequence);
  CREATE INDEX IF NOT EXISTS events_session_id_idx ON events(session_id);
  CREATE INDEX IF NOT EXISTS events_session_sequence_idx ON events(session_id, sequence);
  CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp);

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    sort_index INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status);

  CREATE TABLE IF NOT EXISTS cache_entries (
    type TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    error TEXT,
    PRIMARY KEY (type, cache_key)
  );

  CREATE INDEX IF NOT EXISTS cache_entries_type_idx ON cache_entries(type);

  CREATE TABLE IF NOT EXISTS sidebar_app_preferences (
    scope TEXT NOT NULL,
    app_id TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, app_id)
  );

  CREATE INDEX IF NOT EXISTS sidebar_app_preferences_scope_idx ON sidebar_app_preferences(scope);

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
`;
