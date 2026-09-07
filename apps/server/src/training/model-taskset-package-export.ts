import path from "node:path";
import { contentHash, type ImmutableAssetRef } from "@openpond/harness";
import { materializePortableTasksetRelease, computeTasksetHash } from "@openpond/taskset-sdk";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import type { SqliteStore } from "../store/store.js";
import { captureLocalTasksetPackage } from "./taskset-package-capture.js";
import { resolveLocalTasksetModelResources } from "./taskset-package-resources.js";
import { tasksetPackageDirectoryId } from "./taskset-package-path.js";
import { desktopTasksetRuntimeAdapterId } from "./portable-evals-adapter.js";

/** Export only the selected immutable revision of a Model in this Profile.
 * No hosted state or local Model configuration changes during preparation. */
export async function exportLocalModelTasksetPackage(input: {
  store: SqliteStore;
  storeDir: string;
  profileId: string;
  modelId: string;
}): Promise<TasksetPackage> {
  const model = await input.store.getModelProject(input.modelId);
  if (!model || model.profileId !== input.profileId) throw new Error("Model is unavailable in this Profile.");
  const ref = model.trainingSetup.tasksetRef;
  if (!ref) throw new Error("Select a published Taskset before exporting its package.");
  const taskset = await input.store.getTasksetRevision(ref.id, ref.revision);
  if (!taskset || taskset.profileId !== input.profileId || taskset.contentHash !== ref.contentHash || computeTasksetHash(taskset) !== ref.contentHash) throw new Error("Model Taskset differs from its selected immutable revision.");
  const releases = materializePortableTasksetRelease({ taskset, adapterId: desktopTasksetRuntimeAdapterId(taskset) });
  const resources = await resolveLocalTasksetModelResources({
    store: input.store,
    taskset,
    release: releases.tasksetRelease,
    executionResources: { environment: releases.environmentRelease, verifierSet: releases.verifierSetRelease },
  });
  const { taskset: release, executionResources: _executionResources, ...modelResources } = resources;
  const inline = new Set(resources.assets.map(asset => asset.id));
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
    content: { schemaVersion: "openpond.tasksetPackage.v1", taskset: release, environment: releases.environmentRelease, verifierSet: releases.verifierSetRelease, modelResources },
    sources: [...sources.values()],
  });
  // Do not hand a newly stale selection to a caller about to publish it.
  const current = await input.store.getModelProject(input.modelId);
  if (!current || current.profileId !== input.profileId || current.revision !== model.revision) throw new Error("Model changed during package export. Refresh before publishing.");
  return captured;
}
