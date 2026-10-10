export const CHAT_RESOURCE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS local_resource_owner (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_dataset_workspaces (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_dataset_versions (id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id, revision));
CREATE TABLE IF NOT EXISTS local_dataset_operations (operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_hosted_experiments (id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, configuration_hash TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_experiment_groups (operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_resource_links (session_id TEXT NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id, turn_id, kind, resource_id));
CREATE INDEX IF NOT EXISTS chat_resource_links_resource_idx ON chat_resource_links(kind, resource_id, session_id);
`;
