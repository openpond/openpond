type ExecuteSql = (sql: string) => Promise<void>;

export async function createCreateImproveRunTables(exec: ExecuteSql): Promise<void> {
  await exec(`
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
  `);
}

export async function createTasksetRevisionTables(exec: ExecuteSql): Promise<void> {
  await exec(`
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
    CREATE UNIQUE INDEX IF NOT EXISTS taskset_revisions_hash_idx
      ON taskset_revisions(taskset_id, content_hash);
  `);
}

export async function createTaskCreationProjectionTables(exec: ExecuteSql): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS task_creation_transcripts (creation_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_creation_transcript_profile_idx ON task_creation_transcripts(profile_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS task_design_proposals (creation_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, profile_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS task_design_proposal_id_idx ON task_design_proposals(proposal_id);
  `);
}

export async function createGraderAuditTables(exec: ExecuteSql): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS grader_audit_reports (id TEXT PRIMARY KEY, taskset_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS grader_audit_taskset_idx ON grader_audit_reports(taskset_id, created_at DESC);
  `);
}

export async function createTaskAttemptArtifactTables(exec: ExecuteSql): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS task_attempt_artifacts (id TEXT PRIMARY KEY, taskset_id TEXT NOT NULL, attempt_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_attempt_artifacts_attempt_idx ON task_attempt_artifacts(attempt_id, created_at);
    CREATE INDEX IF NOT EXISTS task_attempt_artifacts_taskset_idx ON task_attempt_artifacts(taskset_id, created_at);
  `);
}

export async function createCrossSystemFrontierBaselineRunTables(
  exec: ExecuteSql,
): Promise<void> {
  await exec(`
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
  `);
}

export async function createTasksetBaselineRunTables(exec: ExecuteSql): Promise<void> {
  await exec(`
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
  `);
}

export async function createTrainingReceiptAndModelBindingTables(
  exec: ExecuteSql,
): Promise<void> {
  await exec(`
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
  `);
}

export async function createFireworksModelServingSessionTables(
  exec: ExecuteSql,
): Promise<void> {
  await exec(`
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
  `);
}

export async function deduplicateFireworksMetricArtifacts(exec: ExecuteSql): Promise<void> {
  await exec(`
    DELETE FROM training_artifacts AS older
    WHERE older.kind = 'metrics'
      AND json_extract(older.payload, '$.metadata.provider') = 'fireworks'
      AND EXISTS (
        SELECT 1
        FROM training_artifacts AS newer
        WHERE newer.kind = 'metrics'
          AND newer.job_id = older.job_id
          AND json_extract(newer.payload, '$.metadata.provider') = 'fireworks'
          AND COALESCE(
            json_extract(newer.payload, '$.metadata.metricSource'),
            ''
          ) = COALESCE(
            json_extract(older.payload, '$.metadata.metricSource'),
            ''
          )
          AND (
            newer.created_at > older.created_at
            OR (
              newer.created_at = older.created_at
              AND newer.id > older.id
            )
          )
      );
  `);
}
