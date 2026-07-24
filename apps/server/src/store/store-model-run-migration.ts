type PayloadRow = { payload: string };

type ModelRunMigrationDatabase = {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<unknown>;
};

export async function createModelProjectAndRunDraftTables(
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
    CREATE TABLE IF NOT EXISTS model_run_drafts (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS model_run_drafts_profile_updated_idx
      ON model_run_drafts(profile_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS model_run_drafts_model_idx
      ON model_run_drafts(model_id, updated_at DESC);
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
      schemaVersion: "openpond.modelProject.v1",
      id: modelId,
      profileId,
      name: String(legacy.name ?? "Untitled Model"),
      objective: typeof legacy.objective === "string" ? legacy.objective : null,
      defaultBaseModel: legacy.baseModel ?? null,
      defaultDestinationId: legacy.destinationId ?? null,
      createdAt,
      updatedAt,
    };
    const draft = {
      schemaVersion: "openpond.modelRunDraft.v1",
      id: String(legacy.id),
      profileId,
      modelId,
      status: legacy.status,
      title: "Run draft",
      datasetMode: legacy.datasetMode ?? null,
      tasksetRef: legacy.tasksetRef ?? null,
      datasetCreationId: legacy.datasetCreationId ?? null,
      buildIntent: legacy.buildIntent ?? null,
      buildSpecification: legacy.buildSpecification ?? null,
      baseModel: legacy.baseModel ?? null,
      method: legacy.method ?? null,
      destinationId: legacy.destinationId ?? null,
      runPreset: legacy.runPreset ?? null,
      recipe: legacy.recipe ?? null,
      createdAt,
      updatedAt,
    };
    await database.run(
      `INSERT INTO model_projects (id, profile_id, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      [modelId, profileId, JSON.stringify(project), createdAt, updatedAt],
    );
    await database.run(
      `INSERT INTO model_run_drafts
        (id, profile_id, model_id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [
        draft.id,
        profileId,
        modelId,
        String(draft.status),
        JSON.stringify(draft),
        createdAt,
        updatedAt,
      ],
    );
  }
  await database.exec(`
    DROP INDEX IF EXISTS model_build_drafts_profile_updated_idx;
    DROP INDEX IF EXISTS model_build_drafts_model_idx;
    DROP TABLE IF EXISTS model_build_drafts;
  `);
}
