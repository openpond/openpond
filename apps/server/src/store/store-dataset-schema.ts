export async function createDatasetImportTables(input: {
  all: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  exec: (sql: string) => Promise<void>;
}): Promise<void> {
  const columns = await input.all<{ name: string }>(
    "PRAGMA table_info(training_sources)",
    [],
  );
  if (!columns.some((column) => column.name === "source_kind")) {
    await input.exec(`
      DROP INDEX IF EXISTS training_sources_profile_updated_idx;
      DROP INDEX IF EXISTS training_sources_session_idx;
      ALTER TABLE training_sources RENAME TO training_sources_legacy;
      CREATE TABLE training_sources (
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
      INSERT INTO training_sources (
        id, profile_id, source_kind, session_id, source_hash,
        repository_id, revision, payload, created_at, updated_at
      )
      SELECT
        id,
        profile_id,
        'conversation',
        session_id,
        COALESCE(json_extract(payload, '$.sourceHash'), id),
        NULL,
        NULL,
        payload,
        created_at,
        updated_at
      FROM training_sources_legacy;
      DROP TABLE training_sources_legacy;
    `);
  }
  await input.exec(`
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
  `);
}
