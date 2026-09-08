import { TasksetSchema, type Taskset } from "@openpond/contracts";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

/** The current pointer and immutable history advance in the same write. */
export function saveTasksetRevision(db: OpenPondSqliteConnection, taskset: Taskset): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const revision = db.get<{ content_hash: string; profile_id: string }>(
      "SELECT content_hash, profile_id FROM taskset_revisions WHERE taskset_id = ? AND revision = ?",
      [taskset.id, taskset.revision],
    );
    if (revision && revision.content_hash !== taskset.contentHash) {
      throw new Error(`Taskset ${taskset.id}@${taskset.revision} is immutable and already has another content hash.`);
    }
    const row = db.get<{ payload: string }>("SELECT payload FROM tasksets WHERE id = ?", [taskset.id]);
    const current = row ? TasksetSchema.parse(JSON.parse(row.payload)) : null;
    if ((revision && revision.profile_id !== taskset.profileId) || (current && current.profileId !== taskset.profileId)) {
      throw new Error(`Taskset ${taskset.id} belongs to another Profile.`);
    }
    const payload = JSON.stringify(taskset);
    db.run(
      `INSERT INTO taskset_revisions (taskset_id, revision, content_hash, profile_id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(taskset_id, revision) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`,
      [taskset.id, taskset.revision, taskset.contentHash, taskset.profileId, taskset.status, payload, taskset.createdAt, taskset.updatedAt],
    );
    // Historical readiness/status reconciliation must not select an old revision.
    if (!current || current.revision <= taskset.revision) {
      db.run(
        `INSERT INTO tasksets (id, profile_id, status, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`,
        [taskset.id, taskset.profileId, taskset.status, payload, taskset.createdAt, taskset.updatedAt],
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
