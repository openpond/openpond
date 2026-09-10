import path from "node:path";
import { contentHash, type ImmutableAssetRef } from "@openpond/harness";
import type { Taskset } from "@openpond/contracts";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import { captureLocalTasksetPackage } from "./taskset-package-capture.js";
import { tasksetPackageDirectoryId } from "./taskset-package-path.js";
import { AuthoredTasksetFileInventorySchema } from "./authored-taskset-files.js";

/** Capture native authoring bytes without entering the store write queue. */
export async function captureAuthoredModelTasksetPackage(input: {
  storeDir: string;
  taskset: Taskset;
  content: Omit<TasksetPackage, "files" | "contentHash">;
}): Promise<TasksetPackage> {
  const { taskset } = input;
  const { taskset: release, modelResources, learningResources } = input.content;
  const inline = new Set([...(modelResources?.assets ?? []), ...(learningResources?.assets ?? [])].map(asset => asset.id));
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
  return captureLocalTasksetPackage({
    root: path.join(input.storeDir, "training", "tasksets", tasksetPackageDirectoryId(taskset)),
    content: input.content,
    sources: [...sources.values()],
  });
}
