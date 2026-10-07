type Row = { payload: string; updated_at: string };
type PayloadRow = { id: string; payload: string };
type TableRow = { name: string };

type MigrationDatabase = {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<unknown>;
};

const EMPTY_SETUP = {
  tasksetRef: null,
  harnessRelease: null,
  tasksetRelease: null,
  baseModel: null,
  method: null,
  destinationId: null,
  managedRolloutPlacement: "remote" as const,
  runPreset: null,
  recipe: null,
  preferredMaximumSpendUsd: null,
  preferredRetentionDays: null,
};

/** Consolidates the former unsubmitted-run rows into one Project setup. */
export async function consolidateModelProjectTrainingSetup(
  database: MigrationDatabase,
): Promise<void> {
  const legacyTable = "model_run_drafts";
  const table = await database.all<TableRow>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [legacyTable],
  );
  const latestByProject = new Map<string, Record<string, unknown>>();
  if (table.length > 0) {
    const rows = await database.all<Row>(
      `SELECT payload, updated_at FROM ${legacyTable} ORDER BY updated_at DESC`,
    );
    for (const row of rows) {
      const value = JSON.parse(row.payload) as Record<string, unknown>;
      const projectId = typeof value.modelId === "string" ? value.modelId : null;
      if (projectId && !latestByProject.has(projectId)) {
        latestByProject.set(projectId, value);
      }
    }
  }

  const projects = await database.all<Row>(
    "SELECT payload, updated_at FROM model_projects ORDER BY updated_at ASC",
  );
  for (const row of projects) {
    const { ModelProjectSchema } = await import("openpond-sdk/model-projects");
    const { sanitizeUnverifiableLearnedPreferenceBindings } = await import("./store-learned-preference-migration-validation.js");
    const stored = JSON.parse(row.payload) as Record<string, unknown>;
    const projectId = String(stored.id);
    const legacy = latestByProject.get(projectId);
    const currentSetup = isRecord(stored.trainingSetup)
      ? stored.trainingSetup
      : EMPTY_SETUP;
    const legacyUpdatedAt = legacy && typeof legacy.updatedAt === "string"
      ? legacy.updatedAt
      : null;
    const shouldMerge = Boolean(
      legacy && legacyUpdatedAt && legacyUpdatedAt >= row.updated_at,
    );
    const trainingSetup = shouldMerge && legacy
      ? {
          ...EMPTY_SETUP,
          ...currentSetup,
          tasksetRef: legacy.tasksetRef ?? currentSetup.tasksetRef ?? null,
          harnessRelease:
            legacy.harnessRelease ?? currentSetup.harnessRelease ?? null,
          tasksetRelease:
            legacy.tasksetRelease ?? currentSetup.tasksetRelease ?? null,
          baseModel: legacy.baseModel ?? currentSetup.baseModel ?? null,
          method: legacy.method ?? currentSetup.method ?? null,
          destinationId:
            legacy.destinationId ?? currentSetup.destinationId ?? null,
          managedRolloutPlacement:
            legacy.managedRolloutPlacement ??
            currentSetup.managedRolloutPlacement ??
            "remote",
          runPreset: legacy.runPreset ?? currentSetup.runPreset ?? null,
          recipe: legacy.recipe ?? currentSetup.recipe ?? null,
        }
      : { ...EMPTY_SETUP, ...currentSetup };
    const normalizedTrainingSetup = sanitizeUnverifiableLearnedPreferenceBindings(
      trainingSetup,
    ).value;
    const sourceRevision =
      typeof stored.revision === "number" && Number.isInteger(stored.revision)
        ? stored.revision
        : 1;
    const updatedAt = shouldMerge && legacyUpdatedAt
      ? legacyUpdatedAt
      : String(stored.updatedAt ?? row.updated_at);
    const project = ModelProjectSchema.parse({
      ...stored,
      schemaVersion: "openpond.modelProject.v2",
      revision: sourceRevision + 1,
      trainingSetup: normalizedTrainingSetup,
      hosted: stored.hosted ?? null,
      tasksetSyncs: stored.tasksetSyncs ?? [],
      updatedAt,
    });
    await database.run(
      "UPDATE model_projects SET payload = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(project), project.updatedAt, project.id],
    );
  }

  await database.exec(`
    DROP INDEX IF EXISTS model_run_drafts_profile_updated_idx;
    DROP INDEX IF EXISTS model_run_drafts_model_idx;
    DROP TABLE IF EXISTS model_run_drafts;
  `);
}

/** Repairs stores that completed schema v49 before strict receipt binding landed. */
export async function repairUnverifiableLearnedPreferenceBindings(
  database: MigrationDatabase,
): Promise<void> {
  for (const table of ["model_projects", "model_runs", "training_plans"] as const) {
    const exists = await database.all<TableRow>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [table],
    );
    if (exists.length === 0) continue;
    const rows = await database.all<PayloadRow>(
      `SELECT id, payload FROM ${table} WHERE payload LIKE '%learnedPreference%'`,
    );
    for (const row of rows) {
      const { sanitizeUnverifiableLearnedPreferenceBindings } = await import("./store-learned-preference-migration-validation.js");
      const normalized = sanitizeUnverifiableLearnedPreferenceBindings(
        JSON.parse(row.payload),
      );
      if (!normalized.changed) continue;
      await database.run(`UPDATE ${table} SET payload = ? WHERE id = ?`, [
        JSON.stringify(normalized.value),
        row.id,
      ]);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
