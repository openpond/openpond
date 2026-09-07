import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { Taskset } from "@openpond/contracts";
import { sha256 } from "@openpond/taskset-sdk";

/** Check copied policy inputs before an immutable package becomes visible. */
export async function verifyPublishedTasksetAssets(tasksetRoot: string, taskset: Taskset): Promise<void> {
  const assetRoot = path.resolve(tasksetRoot, "assets");
  for (const task of taskset.tasks) {
    for (const asset of task.assets ?? []) {
      const assetPath = path.resolve(tasksetRoot, asset.artifactRef);
      if (assetPath === assetRoot || !assetPath.startsWith(`${assetRoot}${path.sep}`)) throw new Error(`Taskset asset ${asset.id} escapes the package assets directory.`);
      const status = await lstat(assetPath);
      if (!status.isFile() || status.isSymbolicLink()) throw new Error(`Taskset asset ${asset.id} is not a regular file.`);
      const bytes = await readFile(assetPath);
      if (bytes.byteLength !== asset.sizeBytes || sha256(bytes) !== asset.sha256) throw new Error(`Taskset asset ${asset.id} does not match its immutable manifest.`);
    }
  }
}
