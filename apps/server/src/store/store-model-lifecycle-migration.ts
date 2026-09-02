type ModelLifecycleMigrationDatabase = {
  exec(sql: string): Promise<void>;
};

export async function createModelLifecycleTables(
  database: ModelLifecycleMigrationDatabase,
): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS model_versions (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(model_id, version_number)
    );
    CREATE INDEX IF NOT EXISTS model_versions_profile_created_idx
      ON model_versions(profile_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS model_versions_model_idx
      ON model_versions(model_id, version_number DESC);

    CREATE TABLE IF NOT EXISTS model_runs (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      model_version_id TEXT,
      profile_id TEXT NOT NULL,
      taskset_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS model_runs_profile_updated_idx
      ON model_runs(profile_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS model_runs_model_updated_idx
      ON model_runs(model_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS model_runs_taskset_updated_idx
      ON model_runs(taskset_id, updated_at DESC);
  `);
}
