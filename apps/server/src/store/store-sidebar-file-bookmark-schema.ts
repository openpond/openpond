export async function createSidebarFileBookmarkTables(
  exec: (sql: string) => Promise<void>,
): Promise<void> {
  await exec(`
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
  `);
}
