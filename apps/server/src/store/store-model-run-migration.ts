type PayloadRow = { payload: string };

type ModelRunMigrationDatabase = {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<unknown>;
};

export async function createModelProjectTables(
  database: ModelRunMigrationDatabase,
): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS model_projects (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS model_projects_profile_updated_idx
      ON model_projects(profile_id, updated_at DESC);
  `);
  const rows = await database.all<PayloadRow>(
    "SELECT payload FROM model_build_drafts ORDER BY updated_at ASC",
  );
  for (const row of rows) {
    const legacy = JSON.parse(row.payload) as Record<string, unknown>;
    const createdAt = String(legacy.createdAt);
    const updatedAt = String(legacy.updatedAt);
    const modelId = String(legacy.modelId);
    const profileId = String(legacy.profileId);
    const project = {
      schemaVersion: "openpond.modelProject.v2",
      id: modelId,
      profileId,
      revision: 1,
      name: String(legacy.name ?? "Untitled Model"),
      objective: typeof legacy.objective === "string" ? legacy.objective : null,
      defaultBaseModel: legacy.baseModel ?? null,
      defaultDestinationId: legacy.destinationId ?? null,
      trainingSetup: {
        tasksetRef: legacy.tasksetRef ?? null,
        harnessRelease: null,
        tasksetRelease: null,
        baseModel: legacy.baseModel ?? null,
        method: legacy.method ?? null,
        destinationId: legacy.destinationId ?? null,
        managedRolloutPlacement: legacy.managedRolloutPlacement ?? "remote",
        runPreset: legacy.runPreset ?? null,
        recipe: legacy.recipe ?? null,
        preferredMaximumSpendUsd: null,
        preferredRetentionDays: null,
      },
      hosted: null,
      tasksetSyncs: [],
      createdAt,
      updatedAt,
    };
    await database.run(
      `INSERT INTO model_projects (id, profile_id, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      [modelId, profileId, JSON.stringify(project), createdAt, updatedAt],
    );
  }
  await database.exec(`
    DROP INDEX IF EXISTS model_build_drafts_profile_updated_idx;
    DROP INDEX IF EXISTS model_build_drafts_model_idx;
    DROP TABLE IF EXISTS model_build_drafts;
  `);
}

export async function allowModelRunsWithoutVersion(
  database: ModelRunMigrationDatabase,
): Promise<void> {
  await database.exec(`
    ALTER TABLE model_runs RENAME TO model_runs_before_nullable_version;
    CREATE TABLE model_runs (
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
    INSERT INTO model_runs (
      id, model_id, model_version_id, profile_id, taskset_id, status, payload,
      created_at, updated_at
    )
    SELECT id, model_id, model_version_id, profile_id, taskset_id, status,
      payload, created_at, updated_at
    FROM model_runs_before_nullable_version;
    DROP TABLE model_runs_before_nullable_version;
    CREATE INDEX model_runs_profile_updated_idx ON model_runs(profile_id, updated_at DESC);
    CREATE INDEX model_runs_model_updated_idx ON model_runs(model_id, updated_at DESC);
    CREATE INDEX model_runs_taskset_updated_idx ON model_runs(taskset_id, updated_at DESC);
  `);
}
