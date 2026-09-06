export const MODEL_PROJECT_AUTHORING_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS model_project_save_operations (
  profile_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (profile_id, operation_id)
);
`;
