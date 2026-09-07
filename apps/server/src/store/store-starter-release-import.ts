import { learningResourceSchemas, type LearningResourceFor } from "@openpond/evals/learning";
import { canonicalJson } from "openpond-sdk/training";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

/** The caller owns the transaction and has validated the exact catalog package.
 * Imported history may start at any revision. Ordinary edits still use the
 * learning repository's compare-and-set rather than this publication boundary. */
export function importStarterReleaseInTransaction<K extends "asset" | "reward" | "binding" | "definition">(
  db: OpenPondSqliteConnection, scope: string, kind: K, value: LearningResourceFor<K>,
) {
  const resource = learningResourceSchemas[kind].parse(value);
  const existing = db.get<{ payload: string }>("SELECT payload FROM learning_revisions WHERE scope = ? AND kind = ? AND id = ? AND revision = ?", [scope, kind, resource.id, resource.revision]);
  if (existing) {
    if (canonicalJson(JSON.parse(existing.payload)) !== canonicalJson(resource)) throw new Error(`Starter dependency conflicts with an existing revision: ${resource.id}.`);
    return;
  }
  db.run("INSERT INTO learning_revisions (scope, kind, id, revision, payload) VALUES (?, ?, ?, ?, ?)", [scope, kind, resource.id, resource.revision, JSON.stringify(resource)]);
  db.run(`INSERT INTO learning_resources (scope, kind, id, revision) VALUES (?, ?, ?, ?)
    ON CONFLICT (scope, kind, id) DO UPDATE SET revision = excluded.revision
    WHERE learning_resources.revision < excluded.revision`, [scope, kind, resource.id, resource.revision]);
}
