export async function createHarnessWorkspaceTables(
  exec: (sql: string) => Promise<void>,
): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS harness_workspaces (
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      location TEXT NOT NULL,
      revision INTEGER NOT NULL,
      source_revision TEXT NOT NULL,
      channel_revision INTEGER NOT NULL,
      current_release_hash TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS harness_workspaces_owner_updated_idx
      ON harness_workspaces(owner_kind, owner_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS harness_workspace_selections (
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_kind, owner_id),
      FOREIGN KEY(workspace_id) REFERENCES harness_workspaces(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS harness_workspace_selections_workspace_idx
      ON harness_workspace_selections(workspace_id);

    CREATE TABLE IF NOT EXISTS harness_workspace_settings (
      workspace_id TEXT PRIMARY KEY,
      background_review_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES harness_workspaces(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS harness_release_records (
      content_hash TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      bundle_path TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES harness_workspaces(id) ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS harness_release_records_id_hash_idx
      ON harness_release_records(id, content_hash);
    CREATE INDEX IF NOT EXISTS harness_release_records_workspace_created_idx
      ON harness_release_records(workspace_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS harness_improvement_artifacts (
      content_hash TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES harness_workspaces(id) ON DELETE RESTRICT
    );

    DROP INDEX IF EXISTS harness_improvement_artifacts_id_kind_idx;
    CREATE INDEX IF NOT EXISTS harness_improvement_artifacts_id_kind_idx
      ON harness_improvement_artifacts(id, kind);
    CREATE INDEX IF NOT EXISTS harness_improvement_artifacts_workspace_kind_created_idx
      ON harness_improvement_artifacts(workspace_id, kind, created_at DESC);

    CREATE TABLE IF NOT EXISTS harness_advance_receipts (
      content_hash TEXT PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES harness_workspaces(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS harness_advance_receipts_workspace_created_idx
      ON harness_advance_receipts(workspace_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS harness_run_overlays (
      run_id TEXT PRIMARY KEY,
      overlay_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES harness_workspaces(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS harness_run_overlays_workspace_updated_idx
      ON harness_run_overlays(workspace_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS harness_memory_revisions (
      workspace_id TEXT NOT NULL,
      key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, key, revision),
      FOREIGN KEY(workspace_id) REFERENCES harness_workspaces(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS harness_memory_revisions_workspace_created_idx
      ON harness_memory_revisions(workspace_id, created_at DESC);
  `);
}
