import path from "node:path";
import { contentHash, type ImmutableAssetRef } from "@openpond/harness";
import { materializePortableTasksetRelease, computeTasksetHash } from "@openpond/taskset-sdk";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import type { SqliteStore } from "../store/store.js";
import { captureLocalTasksetPackage } from "./taskset-package-capture.js";
import { resolveLocalTasksetModelResources } from "./taskset-package-resources.js";
import { tasksetPackageDirectoryId } from "./taskset-package-path.js";
import { desktopTasksetRuntimeAdapterId } from "./portable-evals-adapter.js";
import { readCachedTasksetPackage } from "./taskset-package-files.js";

/** Export the selected or explicitly requested immutable revision in this Profile.
 * No hosted state or local Model configuration changes during preparation. */
export async function exportLocalModelTasksetPackage(input: {
  store: SqliteStore;
  storeDir: string;
  profileId: string;
  modelId: string;
  tasksetRef?: { id: string; revision: number; contentHash: string };
}): Promise<TasksetPackage> {
  const model = await input.store.getModelProject(input.modelId);
  if (!model || model.profileId !== input.profileId) throw new Error("Model is unavailable in this Profile.");
  const ref = input.tasksetRef ?? model.trainingSetup.tasksetRef;
  if (!ref) throw new Error("Select a published Taskset before exporting its package.");
  const taskset = await input.store.getTasksetRevision(ref.id, ref.revision);
  if (!taskset || taskset.profileId !== input.profileId || taskset.contentHash !== ref.contentHash || computeTasksetHash(taskset) !== ref.contentHash) throw new Error("Model Taskset differs from its selected immutable revision.");
  const linkedPackage = model.hosted?.tasksets.find(link => link.localTasksetId === taskset.id && link.localTasksetHash === taskset.contentHash);
  const packageHash = typeof taskset.metadata.importedPackageHash === "string" ? taskset.metadata.importedPackageHash : linkedPackage?.packageHash;
  if (packageHash) {
    const cached = await readCachedTasksetPackage(input.storeDir, packageHash);
    if (cached.taskset.id !== (linkedPackage?.releaseId ?? taskset.id) || cached.taskset.revision !== (linkedPackage?.releaseRevision ?? taskset.revision)) throw new Error("Imported package differs from the selected Taskset revision.");
    const { files, contentHash: _hash, ...content } = cached;
    const inline = new Set(typeof taskset.metadata.importedPackageHash === "string" ? [] : cached.modelResources?.assets.map(asset => asset.id));
    const captured = await captureLocalTasksetPackage({
      root: path.join(input.storeDir, "training", "tasksets", tasksetPackageDirectoryId(taskset)),
      content, sources: files.filter(file => !inline.has(file.asset.id)).map(file => ({ asset: file.asset, sourcePath: taskset.tasks.flatMap(task => task.assets ?? []).find(asset => asset.id === file.asset.id)?.artifactRef ?? file.asset.path })), fileOrder: files.map(file => file.asset.id),
    });
    if (captured.contentHash !== cached.contentHash) throw new Error("Imported package changed during export.");
    const current = await input.store.getModelProject(input.modelId);
    if (!current || current.profileId !== input.profileId || current.revision !== model.revision) throw new Error("Model changed during package export. Refresh before publishing.");
    return captured;
  }
  const releases = materializePortableTasksetRelease({ taskset, adapterId: desktopTasksetRuntimeAdapterId(taskset) });
  const resources = taskset.metadata.taskDefinition === undefined && taskset.metadata.rewardBinding === undefined ? null : await resolveLocalTasksetModelResources({
    store: input.store,
    taskset,
    release: releases.tasksetRelease,
    executionResources: { environment: releases.environmentRelease, verifierSet: releases.verifierSetRelease },
  });
  const release = resources?.taskset ?? releases.tasksetRelease;
  let modelResources: TasksetPackage["modelResources"];
  if (resources) {
    const { taskset: _taskset, executionResources: _executionResources, ...portableResources } = resources;
    modelResources = portableResources;
  }
  const inline = new Set(resources?.assets.map(asset => asset.id));
  const sources = new Map<string, { asset: ImmutableAssetRef; sourcePath: string }>();
  const add = (asset: ImmutableAssetRef, sourcePath = asset.path) => {
    if (inline.has(asset.id)) return;
    const existing = sources.get(asset.id);
    if (existing && (contentHash(existing.asset) !== contentHash(asset) || existing.sourcePath !== sourcePath)) throw new Error(`Conflicting local Taskset file reference: ${asset.id}.`);
    sources.set(asset.id, { asset, sourcePath });
  };
  for (const task of release.tasks) {
    const local = taskset.tasks.find(candidate => candidate.id === task.id);
    for (const asset of task.artifactRefs) add(asset, local?.assets?.find(candidate => candidate.id === asset.id)?.artifactRef ?? asset.path);
    for (const output of task.requiredOutputs ?? []) if (output.schemaRef) add(output.schemaRef);
  }
  for (const grader of release.graders) {
    if ("verifierRef" in grader) add(grader.verifierRef);
    if ("rubricRef" in grader) add(grader.rubricRef);
  }
  const captured = await captureLocalTasksetPackage({
    root: path.join(input.storeDir, "training", "tasksets", tasksetPackageDirectoryId(taskset)),
    content: { schemaVersion: "openpond.tasksetPackage.v1", taskset: release, environment: releases.environmentRelease, verifierSet: releases.verifierSetRelease, ...(modelResources ? { modelResources } : {}) },
    sources: [...sources.values()],
  });
  // Do not hand a newly stale selection to a caller about to publish it.
  const current = await input.store.getModelProject(input.modelId);
  if (!current || current.profileId !== input.profileId || current.revision !== model.revision) throw new Error("Model changed during package export. Refresh before publishing.");
  return captured;
}
