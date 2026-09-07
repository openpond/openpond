export const MODEL_PROJECT_AUTHORING_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS model_project_package_operations (
  operation_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  api_origin TEXT NOT NULL,
  team_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'rejected')),
  payload TEXT NOT NULL,
  receipt TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS model_project_package_pending
  ON model_project_package_operations (profile_id, model_id) WHERE state = 'pending';
CREATE TABLE IF NOT EXISTS model_project_save_operations (
  profile_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (profile_id, operation_id)
);
CREATE TABLE IF NOT EXISTS model_starter_creation_operations (
  profile_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (profile_id, operation_id)
);
CREATE TABLE IF NOT EXISTS model_project_taskset_preparations (
  profile_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'materialized', 'committed')),
  PRIMARY KEY (profile_id, operation_id)
);
`;
