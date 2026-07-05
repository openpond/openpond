export const CURRENT_SQLITE_SCHEMA_VERSION = 7;

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
