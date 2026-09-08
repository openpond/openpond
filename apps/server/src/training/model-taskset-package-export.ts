import path from "node:path";
import { contentHash, type ImmutableAssetRef } from "@openpond/harness";
import { materializePortableTasksetRelease, computeTasksetHash } from "@openpond/taskset-sdk";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import { requireLearningRelease, requireLearningResource, taskBatchPackageMetadata } from "@openpond/evals/learning";
import type { SqliteStore } from "../store/store.js";
import { captureLocalTasksetPackage, tasksetPackageInlineAssetIds } from "./taskset-package-capture.js";
import { resolveLocalTasksetModelResources } from "./taskset-package-resources.js";
import { tasksetPackageDirectoryId } from "./taskset-package-path.js";
import { desktopTasksetRuntimeAdapterId } from "./portable-evals-adapter.js";
import { readCachedTasksetPackage } from "./taskset-package-files.js";
import { AuthoredTasksetFileInventorySchema } from "./authored-taskset-files.js";

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
    const inline = tasksetPackageInlineAssetIds(cached, typeof taskset.metadata.importedPackageHash === "string");
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
  const learningResources = taskset.metadata.learning === undefined ? undefined : await input.store.learningRepository().transaction(input.profileId, async transaction => {
    const metadata = taskBatchPackageMetadata(releases.tasksetRelease);
    const batch = await requireLearningRelease(transaction, "batch", metadata.batch);
    const evidence = await Promise.all(batch.examples.map(entry => requireLearningRelease(transaction, "evidence", entry.evidence)));
    const decisions = await Promise.all(batch.examples.map(entry => requireLearningRelease(transaction, "decision", entry.decision)));
    const sourceRefs = [...new Map(evidence.map(item => [contentHash(item.source), item.source])).values()];
    const sources = await Promise.all(sourceRefs.map(ref => requireLearningRelease(transaction, "source", ref)));
    const assetIds = new Set(metadata.rewards.flatMap(reward => [
      ...reward.assets.map(asset => asset.id),
      ...(reward.implementation.kind === "custom_verifier" ? [reward.implementation.verifierRef.id]
        : reward.implementation.kind === "model_judge" || reward.implementation.kind === "human" ? [reward.implementation.rubricRef.id] : []),
      ...("inputContract" in reward.implementation ? [reward.implementation.inputContract.id] : []),
    ]));
    const assets = await Promise.all([...assetIds].map(id => requireLearningResource(transaction, "asset", id, 1)));
    return { batch, evidence, decisions, sources, assets };
  });
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
  const inline = new Set([...(resources?.assets ?? []), ...(learningResources?.assets ?? [])].map(asset => asset.id));
  const sources = new Map<string, { asset: ImmutableAssetRef; sourcePath: string }>();
  const add = (asset: ImmutableAssetRef, sourcePath = asset.path) => {
    if (inline.has(asset.id)) return;
    const existing = sources.get(asset.id);
    if (existing && (contentHash(existing.asset) !== contentHash(asset) || existing.sourcePath !== sourcePath)) throw new Error(`Conflicting local Taskset file reference: ${asset.id}.`);
    sources.set(asset.id, { asset, sourcePath });
  };
  for (const file of AuthoredTasksetFileInventorySchema.parse(taskset.metadata.portableFileInventory ?? [])) add(file.asset, file.sourcePath);
  for (const task of release.tasks) {
    const local = taskset.tasks.find(candidate => candidate.id === task.id);
    for (const asset of task.artifactRefs) add(asset, local?.assets?.find(candidate => candidate.id === asset.id)?.artifactRef ?? asset.path);
    for (const output of task.requiredOutputs ?? []) if (output.schemaRef) add(output.schemaRef);
  }
  for (const grader of release.graders) {
    const local = taskset.graders.find(local => local.id === grader.id);
    if ("verifierRef" in grader) add(grader.verifierRef, local?.kind === "custom_verifier" ? local.module : grader.verifierRef.path);
    if ("rubricRef" in grader) add(grader.rubricRef);
  }
  const captured = await captureLocalTasksetPackage({
    root: path.join(input.storeDir, "training", "tasksets", tasksetPackageDirectoryId(taskset)),
    content: { schemaVersion: "openpond.tasksetPackage.v1", taskset: release, environment: releases.environmentRelease, verifierSet: releases.verifierSetRelease, ...(modelResources ? { modelResources } : {}), ...(learningResources ? { learningResources } : {}) },
    sources: [...sources.values()],
  });
  // Do not hand a newly stale selection to a caller about to publish it.
  const current = await input.store.getModelProject(input.modelId);
  if (!current || current.profileId !== input.profileId || current.revision !== model.revision) throw new Error("Model changed during package export. Refresh before publishing.");
  return captured;
}
