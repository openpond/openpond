type ExecuteSql = (sql: string) => Promise<void>;

export async function createPreferenceComparisonTables(exec: ExecuteSql): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS preference_comparison_releases (
      id TEXT PRIMARY KEY,
      taskset_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_consent TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS preference_comparison_release_identity_idx
      ON preference_comparison_releases(taskset_id, content_hash);
    CREATE INDEX IF NOT EXISTS preference_comparison_release_taskset_idx
      ON preference_comparison_releases(taskset_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS preference_comparison_assignments (
      id TEXT PRIMARY KEY,
      taskset_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      state TEXT NOT NULL,
      reviewer_key TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS preference_comparison_assignment_queue_idx
      ON preference_comparison_assignments(taskset_id, state, created_at ASC);
    CREATE INDEX IF NOT EXISTS preference_comparison_assignment_reviewer_idx
      ON preference_comparison_assignments(reviewer_key, state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS preference_comparison_submissions (
      id TEXT PRIMARY KEY,
      taskset_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      reviewer_key TEXT NOT NULL,
      receipt_hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      UNIQUE(assignment_id, reviewer_key)
    );
    CREATE INDEX IF NOT EXISTS preference_comparison_submission_taskset_idx
      ON preference_comparison_submissions(taskset_id, submitted_at DESC);

    CREATE TABLE IF NOT EXISTS preference_comparison_calibrations (
      id TEXT PRIMARY KEY,
      taskset_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      report_hash TEXT NOT NULL,
      passed INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS preference_comparison_calibration_identity_idx
      ON preference_comparison_calibrations(release_id, report_hash);
    CREATE INDEX IF NOT EXISTS preference_comparison_calibration_taskset_idx
      ON preference_comparison_calibrations(taskset_id, created_at DESC);
  `);
}
