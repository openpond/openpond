import path from "node:path";
import { TasksetSchema } from "@openpond/contracts";
import { ModelProjectSchema, type ModelProjectSaveRequest } from "openpond-sdk/model-projects";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { readCachedTasksetPackage } from "../training/taskset-package-files.js";
import { captureLocalTasksetPackage } from "../training/taskset-package-capture.js";
import { tasksetPackageDirectoryId } from "../training/taskset-package-path.js";

/** Verify the current imported bytes before deriving a new immutable revision. */
export async function loadModelTasksetPackage(db: OpenPondSqliteConnection, home: string, request: ModelProjectSaveRequest) {
  const ref = request.project.trainingSetup.tasksetRef;
  if (!ref) return undefined;
  const row = db.get<{ payload: string }>("SELECT payload FROM taskset_revisions WHERE taskset_id = ? AND revision = ?", [ref.id, ref.revision]);
  if (!row) return undefined;
  const taskset = TasksetSchema.parse(JSON.parse(row.payload));
  // The authoritative save validator reports ownership/revision errors in its
  // defined order. Do not open any files for an invalid selection here.
  if (taskset.profileId !== request.project.profileId || taskset.contentHash !== ref.contentHash) return undefined;
  const modelRow = db.get<{ payload: string }>("SELECT payload FROM model_projects WHERE id = ?", [request.project.id]);
  const model = modelRow ? ModelProjectSchema.parse(JSON.parse(modelRow.payload)) : null;
  if (model && (model.profileId !== request.project.profileId || model.revision !== request.expectedRevision)) return undefined;
  const linked = model?.hosted?.tasksets.find(link => link.localTasksetId === taskset.id && link.localTasksetHash === taskset.contentHash);
  const hash = typeof taskset.metadata.importedPackageHash === "string" ? taskset.metadata.importedPackageHash : linked?.packageHash;
  if (!hash) return undefined;
  const cached = await readCachedTasksetPackage(home, hash);
  if (cached.taskset.id !== (linked?.releaseId ?? ref.id) || cached.taskset.revision !== (linked?.releaseRevision ?? ref.revision)) throw new Error("Cached package differs from its selected Taskset revision.");
  const { files, contentHash: _hash, ...content } = cached;
  const inline = new Set(typeof taskset.metadata.importedPackageHash === "string" ? [] : cached.modelResources?.assets.map(asset => asset.id));
  const captured = await captureLocalTasksetPackage({ root: path.join(home, "training", "tasksets", tasksetPackageDirectoryId(taskset)),
    content, sources: files.filter(file => !inline.has(file.asset.id)).map(file => ({ asset: file.asset, sourcePath: taskset.tasks.flatMap(task => task.assets ?? []).find(asset => asset.id === file.asset.id)?.artifactRef ?? file.asset.path })), fileOrder: files.map(file => file.asset.id) });
  if (captured.contentHash !== cached.contentHash) throw new Error("Imported package bytes changed before the Reward edit.");
  return captured;
}
