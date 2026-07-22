export const CURRENT_SQLITE_SCHEMA_VERSION = 28;

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

  CREATE TABLE IF NOT EXISTS openpond_thread_goals (
    session_id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    status TEXT NOT NULL,
    provisional INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    sort_index INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status);

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

  CREATE TABLE IF NOT EXISTS sidebar_file_bookmarks (
    scope TEXT NOT NULL,
    workspace_kind TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    workspace_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    status TEXT NOT NULL,
    sort_order INTEGER,
    source_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, workspace_kind, workspace_id, file_path)
  );

  CREATE INDEX IF NOT EXISTS sidebar_file_bookmarks_scope_status_order_idx
    ON sidebar_file_bookmarks(scope, status, sort_order, updated_at);

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

  CREATE TABLE IF NOT EXISTS training_sources (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    session_id TEXT,
    source_hash TEXT NOT NULL,
    repository_id TEXT,
    revision TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS training_sources_profile_updated_idx ON training_sources(profile_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS training_sources_session_idx ON training_sources(session_id);
  CREATE INDEX IF NOT EXISTS training_sources_kind_updated_idx ON training_sources(profile_id, source_kind, updated_at DESC);
  CREATE INDEX IF NOT EXISTS training_sources_hash_idx ON training_sources(profile_id, source_hash);
  CREATE INDEX IF NOT EXISTS training_sources_repository_revision_idx ON training_sources(repository_id, revision);

  CREATE TABLE IF NOT EXISTS dataset_import_jobs (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    status TEXT NOT NULL,
    repository_id TEXT,
    revision TEXT,
    taskset_id TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS dataset_import_jobs_profile_updated_idx ON dataset_import_jobs(profile_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS dataset_import_jobs_status_updated_idx ON dataset_import_jobs(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS dataset_import_jobs_repository_revision_idx ON dataset_import_jobs(repository_id, revision);

  CREATE TABLE IF NOT EXISTS dataset_artifacts (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    taskset_id TEXT NOT NULL,
    taskset_revision INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    format TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    storage_root TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS dataset_artifacts_taskset_revision_idx ON dataset_artifacts(taskset_id, taskset_revision);
  CREATE UNIQUE INDEX IF NOT EXISTS dataset_artifacts_content_hash_idx ON dataset_artifacts(content_hash);
  CREATE INDEX IF NOT EXISTS dataset_artifacts_profile_updated_idx ON dataset_artifacts(profile_id, updated_at DESC);

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

  CREATE TABLE IF NOT EXISTS task_creation_snapshots (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    state TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_creation_profile_updated_idx ON task_creation_snapshots(profile_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS task_creation_transcripts (
    creation_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_creation_transcript_profile_idx ON task_creation_transcripts(profile_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS task_design_proposals (
    creation_id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    state TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS task_design_proposal_id_idx ON task_design_proposals(proposal_id);

  CREATE TABLE IF NOT EXISTS tasksets (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasksets_profile_status_updated_idx ON tasksets(profile_id, status, updated_at DESC);

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
  CREATE UNIQUE INDEX IF NOT EXISTS taskset_revisions_hash_idx ON taskset_revisions(taskset_id, content_hash);

  CREATE TABLE IF NOT EXISTS task_candidates (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    status TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS task_candidates_profile_fingerprint_idx ON task_candidates(profile_id, fingerprint);
  CREATE INDEX IF NOT EXISTS task_candidates_profile_status_updated_idx ON task_candidates(profile_id, status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS task_attempts (
    id TEXT PRIMARY KEY,
    taskset_id TEXT NOT NULL,
    split TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_attempts_taskset_split_idx ON task_attempts(taskset_id, split, created_at DESC);

  CREATE TABLE IF NOT EXISTS task_attempt_artifacts (
    id TEXT PRIMARY KEY,
    taskset_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_attempt_artifacts_attempt_idx ON task_attempt_artifacts(attempt_id, created_at);
  CREATE INDEX IF NOT EXISTS task_attempt_artifacts_taskset_idx ON task_attempt_artifacts(taskset_id, created_at);

  CREATE TABLE IF NOT EXISTS grade_results (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS grade_results_attempt_idx ON grade_results(attempt_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS baseline_reports (
    id TEXT PRIMARY KEY,
    taskset_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS baseline_reports_taskset_idx ON baseline_reports(taskset_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS taskset_baseline_runs (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    taskset_id TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS taskset_baseline_runs_profile_updated_idx ON taskset_baseline_runs(profile_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS taskset_baseline_runs_taskset_updated_idx ON taskset_baseline_runs(taskset_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS taskset_baseline_runs_status_updated_idx ON taskset_baseline_runs(status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS grader_audit_reports (
    id TEXT PRIMARY KEY,
    taskset_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS grader_audit_taskset_idx ON grader_audit_reports(taskset_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS readiness_reports (
    taskset_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_miner_configs (
    profile_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

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

  CREATE TABLE IF NOT EXISTS training_plans (
    id TEXT PRIMARY KEY,
    taskset_id TEXT NOT NULL,
    destination_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS training_plans_taskset_idx ON training_plans(taskset_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS training_bundles (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS training_bundles_content_hash_idx ON training_bundles(content_hash);

  CREATE TABLE IF NOT EXISTS training_jobs (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    destination_id TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS training_jobs_status_updated_idx ON training_jobs(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS training_jobs_plan_idx ON training_jobs(plan_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS training_approvals (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    bundle_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS training_approvals_plan_idx ON training_approvals(plan_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS training_job_events (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(job_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS training_job_events_job_sequence_idx ON training_job_events(job_id, sequence);

  CREATE TABLE IF NOT EXISTS training_artifacts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS training_artifacts_job_kind_idx ON training_artifacts(job_id, kind, created_at DESC);

  CREATE TABLE IF NOT EXISTS model_artifact_lineage (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    taskset_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS model_lineage_artifact_idx ON model_artifact_lineage(artifact_id);
  CREATE INDEX IF NOT EXISTS model_lineage_taskset_idx ON model_artifact_lineage(taskset_id, created_at DESC);

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
`;
