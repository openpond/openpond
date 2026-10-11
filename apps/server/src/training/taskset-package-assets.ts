import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { Taskset } from "@openpond/contracts";
import { sha256 } from "@openpond/taskset-sdk";
import { AuthoredTasksetFileInventorySchema } from "./authored-taskset-files.js";

/** Check copied policy inputs before an immutable package becomes visible. */
export async function verifyPublishedTasksetAssets(tasksetRoot: string, taskset: Taskset): Promise<void> {
  const inventory = AuthoredTasksetFileInventorySchema.parse(taskset.metadata.portableFileInventory ?? []);
  for (const file of inventory) {
    const location = path.resolve(tasksetRoot, file.sourcePath);
    if (!location.startsWith(`${path.resolve(tasksetRoot)}${path.sep}`)) throw new Error("Taskset inventory file escapes its package.");
    const status = await lstat(location);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error("Taskset inventory requires regular files.");
    const bytes = await readFile(location);
    if (bytes.length !== file.asset.sizeBytes || sha256(bytes) !== file.asset.contentHash) throw new Error(`Taskset file differs from its immutable inventory: ${file.asset.id}.`);
  }
  const packageRoot = path.resolve(tasksetRoot);
  for (const task of taskset.tasks) {
    for (const asset of task.assets ?? []) {
      const assetPath = path.resolve(tasksetRoot, asset.artifactRef);
      if (!assetPath.startsWith(`${packageRoot}${path.sep}`)) throw new Error(`Taskset asset ${asset.id} escapes its package.`);
      const declared = inventory.find(file => file.asset.id === asset.id && file.sourcePath === asset.artifactRef);
      if (!declared || declared.asset.visibility !== "policy" || declared.asset.contentHash !== asset.sha256
        || declared.asset.sizeBytes !== asset.sizeBytes || declared.asset.mediaType !== asset.mediaType) {
        throw new Error(`Taskset asset ${asset.id} differs from its declared policy inventory.`);
      }
      const status = await lstat(assetPath);
      if (!status.isFile() || status.isSymbolicLink()) throw new Error(`Taskset asset ${asset.id} is not a regular file.`);
      const bytes = await readFile(assetPath);
      if (bytes.byteLength !== asset.sizeBytes || sha256(bytes) !== asset.sha256) throw new Error(`Taskset asset ${asset.id} does not match its immutable manifest.`);
    }
  }
}
