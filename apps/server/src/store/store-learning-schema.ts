export const LEARNING_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS learning_revisions (
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload TEXT NOT NULL,
  PRIMARY KEY (scope, kind, id, revision)
);
CREATE TABLE IF NOT EXISTS learning_resources (
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  parent_id TEXT,
  status TEXT,
  PRIMARY KEY (scope, kind, id),
  FOREIGN KEY (scope, kind, id, revision) REFERENCES learning_revisions (scope, kind, id, revision)
);
CREATE INDEX IF NOT EXISTS learning_parent_idx ON learning_resources (scope, kind, parent_id, id);
CREATE INDEX IF NOT EXISTS learning_status_idx ON learning_resources (scope, kind, status, id);
CREATE TABLE IF NOT EXISTS learning_operations (
  scope TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (scope, id)
);
CREATE TABLE IF NOT EXISTS learning_family_splits (
  scope TEXT NOT NULL,
  namespace TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  split TEXT NOT NULL,
  PRIMARY KEY (scope, namespace, kind, key)
);
`;
