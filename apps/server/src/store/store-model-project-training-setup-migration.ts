import { ModelProjectSchema } from "openpond-sdk/model-projects";
import { LearnedPreferenceRewardBindingSchema } from "@openpond/contracts";

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

/**
 * V2 learned scorers are reusable only when their Sandbox execution receipt is
 * present. Older local rows may contain a qualification label but no execution
 * receipt. Those bindings cannot be upgraded truthfully, so the one-way schema
 * migration unbinds them and leaves the immutable Reward Model history intact.
 */
export function sanitizeUnverifiableLearnedPreferenceBindings(
  value: unknown,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const entries = value.map((entry) => {
      const normalized = sanitizeUnverifiableLearnedPreferenceBindings(entry);
      changed ||= normalized.changed;
      return normalized.value;
    });
    return { value: changed ? entries : value, changed };
  }
  if (!isRecord(value)) return { value, changed: false };

  let changed = false;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "learnedPreference" && entry !== null) {
      const candidate = isRecord(entry)
        ? Object.fromEntries(
            Object.entries(entry).filter(([name]) => name !== "qualificationKind"),
          )
        : entry;
      const parsed = LearnedPreferenceRewardBindingSchema.safeParse(candidate);
      output[key] = parsed.success ? parsed.data : null;
      changed ||= !parsed.success || candidate !== entry;
      continue;
    }
    const normalized = sanitizeUnverifiableLearnedPreferenceBindings(entry);
    output[key] = normalized.value;
    changed ||= normalized.changed;
  }
  return { value: changed ? output : value, changed };
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
