import { TasksetSchema } from "@openpond/contracts";
import { createModelStarterExecutionAsset, createModelTasksetExecutionResourcesAsset } from "openpond-sdk/model-starters";
import { canonicalJson } from "openpond-sdk/training";
import type { PreparedImportedTasksetPackage } from "../training/taskset-package-import.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { importStarterReleaseInTransaction } from "./store-starter-release-import.js";

/** Called only inside the Model replacement transaction, after file validation. */
export function importTasksetPackageInTransaction(db: OpenPondSqliteConnection, prepared: PreparedImportedTasksetPackage) {
  const { taskset, package: value } = prepared;
  const scope = taskset.profileId;
  const existing = db.get<{ payload: string }>("SELECT payload FROM taskset_revisions WHERE taskset_id = ? AND revision = ?", [taskset.id, taskset.revision]);
  if (existing && canonicalJson(TasksetSchema.parse(JSON.parse(existing.payload))) !== canonicalJson(taskset)) throw new Error("Imported Taskset revision conflicts with an existing immutable local revision.");
  const latest = db.get<{ payload: string }>("SELECT payload FROM tasksets WHERE id = ?", [taskset.id]);
  const current = latest ? TasksetSchema.parse(JSON.parse(latest.payload)) : null;
  if (current && current.profileId !== scope) throw new Error("Imported Taskset belongs to another Profile.");
  importStarterReleaseInTransaction(db, scope, "package", value.taskset);
  const resources = value.modelResources;
  if (resources) {
  importStarterReleaseInTransaction(db, scope, "definition", resources.taskDefinition);
  importStarterReleaseInTransaction(db, scope, "binding", resources.rewardBinding);
  for (const reward of resources.rewards) importStarterReleaseInTransaction(db, scope, "reward", reward);
  for (const asset of resources.assets) importStarterReleaseInTransaction(db, scope, "asset", asset);
  importStarterReleaseInTransaction(db, scope, "asset", createModelTasksetExecutionResourcesAsset({ environment: value.environment, verifierSet: value.verifierSet }));
  if (resources.execution) importStarterReleaseInTransaction(db, scope, "asset", createModelStarterExecutionAsset(resources.execution));
  }
  const payload = JSON.stringify(taskset);
  if (!existing) db.run("INSERT INTO taskset_revisions (taskset_id, revision, content_hash, profile_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [taskset.id, taskset.revision, taskset.contentHash, scope, taskset.status, payload, taskset.createdAt, taskset.updatedAt]);
  if (!current || current.revision < taskset.revision) db.run("INSERT INTO tasksets (id, profile_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at", [taskset.id, scope, taskset.status, payload, taskset.createdAt, taskset.updatedAt]);
}
