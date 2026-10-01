/** Separate tables keep local execution ownership out of hosted job state. */
export const LOCAL_EXPERIMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS local_experiment_owner (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_id TEXT NOT NULL,
  pid INTEGER NOT NULL, lease_until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS local_experiment_definitions (
  team_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL, project_id TEXT, payload TEXT NOT NULL, package_payload TEXT NOT NULL,
  PRIMARY KEY (team_id,id,revision)
);
CREATE TABLE IF NOT EXISTS local_experiment_operations (
  team_id TEXT NOT NULL, operation_id TEXT NOT NULL, kind TEXT NOT NULL,
  intent_hash TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY (team_id,operation_id)
);
CREATE TABLE IF NOT EXISTS local_experiment_executions (
  team_id TEXT NOT NULL, id TEXT NOT NULL, definition_id TEXT NOT NULL, definition_revision INTEGER NOT NULL,
  owner_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (team_id,id)
);
CREATE TABLE IF NOT EXISTS local_experiment_cases (
  team_id TEXT NOT NULL, execution_id TEXT NOT NULL, receipt_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  status TEXT NOT NULL, admission TEXT NOT NULL, result TEXT, error TEXT,
  PRIMARY KEY (team_id,execution_id,receipt_id), UNIQUE (team_id,execution_id,ordinal),
  FOREIGN KEY (team_id,execution_id) REFERENCES local_experiment_executions(team_id,id)
);
CREATE TABLE IF NOT EXISTS local_experiment_configurations (
  team_id TEXT NOT NULL, execution_id TEXT NOT NULL, payload TEXT NOT NULL, package_payload TEXT NOT NULL,
  PRIMARY KEY(team_id,execution_id),
  FOREIGN KEY (team_id,execution_id) REFERENCES local_experiment_executions(team_id,id)
);
CREATE TABLE IF NOT EXISTS local_experiment_charges (
  team_id TEXT NOT NULL, execution_id TEXT NOT NULL, request_id TEXT NOT NULL, case_id TEXT NOT NULL,
  maximum_usd REAL NOT NULL CHECK(maximum_usd >= 0), cost_usd REAL CHECK(cost_usd >= 0),
  status TEXT NOT NULL, usage TEXT,
  PRIMARY KEY(team_id,execution_id,request_id),
  FOREIGN KEY (team_id,execution_id) REFERENCES local_experiment_executions(team_id,id)
);
CREATE TABLE IF NOT EXISTS local_experiment_scoring_selections (
  team_id TEXT NOT NULL, execution_id TEXT NOT NULL, source_execution_id TEXT NOT NULL,
  package_payload TEXT NOT NULL, graders TEXT NOT NULL,
  PRIMARY KEY(team_id,execution_id),
  FOREIGN KEY (team_id,execution_id) REFERENCES local_experiment_executions(team_id,id)
);
CREATE TABLE IF NOT EXISTS local_experiment_judge_budgets (
  team_id TEXT NOT NULL, execution_id TEXT NOT NULL, calls TEXT NOT NULL,
  PRIMARY KEY(team_id,execution_id),
  FOREIGN KEY (team_id,execution_id) REFERENCES local_experiment_executions(team_id,id)
);
CREATE TABLE IF NOT EXISTS local_experiment_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL, execution_id TEXT NOT NULL,
  case_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
  FOREIGN KEY (team_id,execution_id) REFERENCES local_experiment_executions(team_id,id)
);
CREATE TABLE IF NOT EXISTS local_experiment_trace_budgets (
  team_id TEXT NOT NULL, execution_id TEXT NOT NULL, event_count INTEGER NOT NULL, byte_count INTEGER NOT NULL,
  PRIMARY KEY(team_id,execution_id), FOREIGN KEY (team_id,execution_id) REFERENCES local_experiment_executions(team_id,id)
);
CREATE INDEX IF NOT EXISTS local_experiment_case_events ON local_experiment_events(team_id,execution_id,case_id,sequence);
CREATE INDEX IF NOT EXISTS local_experiment_definition_project ON local_experiment_definitions(team_id,project_id,id);
CREATE INDEX IF NOT EXISTS local_experiment_execution_definition ON local_experiment_executions(team_id,definition_id,id);
`;
