import { ModelProjectSchema, OpenPondModelProjectApiError, type ModelProject } from "openpond-sdk/model-projects";
import { canonicalJson } from "openpond-sdk/training";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

/** Hosted receipts update server-owned state without reverting local edits. */
export function commitModelProjectHosting(
  db: OpenPondSqliteConnection,
  previous: ModelProject | null,
  value: ModelProject,
  replace: boolean,
): ModelProject {
  const next = ModelProjectSchema.parse(value);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.get<{ payload: string }>("SELECT payload FROM model_projects WHERE id = ?", [next.id]);
    const current = row ? ModelProjectSchema.parse(JSON.parse(row.payload)) : null;
    if (current && current.profileId !== next.profileId) conflict("Model ownership changed during hosted synchronization.");
    let saved: ModelProject;
    if (replace) {
      if (canonicalJson(current) !== canonicalJson(previous)) conflict("Model changed while its hosted configuration was loading. Refresh before applying it.");
      saved = next;
    } else {
      if (!current || !previous || previous.id !== next.id || previous.profileId !== next.profileId) conflict("Model is no longer available for hosted synchronization.");
      if (current.hosted?.teamId !== previous.hosted?.teamId && current.hosted?.teamId !== next.hosted?.teamId) conflict("Model hosting team changed during synchronization.");
      const incoming = next.hosted;
      const existing = current.hosted;
      let hosted = existing;
      if (incoming) {
        const sameProject = existing?.teamId === incoming.teamId && existing.projectId === incoming.projectId;
        if (sameProject && existing.revision === incoming.revision && existing.etag !== incoming.etag) conflict("Hosted Model receipts disagree about the same revision.");
        const latest = sameProject && existing.revision > incoming.revision ? existing : incoming;
        hosted = { ...latest, tasksets: sameProject
          ? mergeLatest(existing.tasksets, incoming.tasksets, (item) => `${item.localTasksetId}:${item.releaseHash}`, (item) => item.syncedAt)
          : incoming.tasksets };
      }
      saved = ModelProjectSchema.parse({ ...current, hosted,
        tasksetSyncs: mergeLatest(current.tasksetSyncs, next.tasksetSyncs, (item) => item.localTasksetId, (item) => item.lastAttemptAt),
      });
    }
    db.run(`INSERT INTO model_projects (id, profile_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    [saved.id, saved.profileId, JSON.stringify(saved), saved.createdAt, saved.updatedAt]);
    db.exec("COMMIT");
    return saved;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function mergeLatest<T>(current: T[], incoming: T[], key: (item: T) => string, timestamp: (item: T) => string): T[] {
  const entries = new Map(current.map((item) => [key(item), item]));
  for (const item of incoming) {
    const existing = entries.get(key(item));
    if (!existing || Date.parse(timestamp(item)) >= Date.parse(timestamp(existing))) entries.set(key(item), item);
  }
  return [...entries.values()];
}

function conflict(message: string): never {
  throw new OpenPondModelProjectApiError(409, { schemaVersion: "openpond.modelProjectApiError.v2",
    code: "model_hosting_conflict", message, retryable: false, requestId: null, details: {} });
}
