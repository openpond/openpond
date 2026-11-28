import type { ModelRun, ModelVersion } from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

export function modelVersionId(modelId: string, version: number): string {
  return `model_version_${contentHash({ modelId, version }).slice(0, 24)}`;
}

export function nextModelVersion(db: OpenPondSqliteConnection, modelId: string) {
  const versions = new Set(db.all<{ version: number }>(
    "SELECT version_number AS version FROM model_versions WHERE model_id = ?", [modelId],
  ).map(row => row.version));
  const reservations = new Set(db.all<{ id: string }>(
    "SELECT model_version_id AS id FROM model_runs WHERE model_id = ? AND model_version_id IS NOT NULL", [modelId],
  ).map(row => row.id));
  let version = 1;
  while (versions.has(version) || reservations.has(modelVersionId(modelId, version))) version++;
  return { id: modelVersionId(modelId, version), version };
}

export const writeModelVersionSql = `INSERT INTO model_versions
  (id, model_id, profile_id, version_number, kind, payload, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`;

export function modelVersionParams(version: ModelVersion) {
  return [version.id, version.modelId, version.profileId, version.version, version.kind, JSON.stringify(version), version.createdAt];
}

export const writeModelRunSql = `INSERT INTO model_runs
  (id, model_id, model_version_id, profile_id, taskset_id, status, payload, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET model_version_id = excluded.model_version_id, status = excluded.status,
    payload = excluded.payload, updated_at = excluded.updated_at`;

export function modelRunParams(run: ModelRun) {
  return [run.id, run.modelId, run.modelVersionId, run.profileId, run.taskset.id, run.status,
    JSON.stringify(run), run.startedAt, run.updatedAt];
}
