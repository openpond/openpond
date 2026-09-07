import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { ImmutableAssetRefSchema, type ImmutableAssetRef } from "@openpond/harness";
import { verifyLearningTextAsset } from "@openpond/evals/learning";
import {
  createTasksetPackage,
  MAX_TASKSET_PACKAGE_BYTES,
  type TasksetPackage,
} from "openpond-sdk/taskset-packages";

/** Source paths are local package locations, which may differ from the portable
 * asset path. Capture bytes before any hosted Model mutation is attempted. */
export async function captureLocalTasksetPackage(input: {
  root: string;
  content: Omit<TasksetPackage, "files" | "contentHash">;
  sources: ReadonlyArray<{ asset: ImmutableAssetRef; sourcePath: string }>;
  fileOrder?: readonly string[];
}): Promise<TasksetPackage> {
  const root = await realpath(input.root);
  const files: TasksetPackage["files"] = [];
  const identities = new Set<string>();
  let encodedBytes = 0;
  const append = (asset: ImmutableAssetRef, bytes: Uint8Array) => {
    if (identities.has(asset.id)) throw new Error(`Duplicate local Taskset asset: ${asset.id}.`);
    identities.add(asset.id);
    encodedBytes += 4 * Math.ceil(bytes.byteLength / 3);
    if (encodedBytes > MAX_TASKSET_PACKAGE_BYTES) throw new Error("Local Taskset files exceed the package envelope.");
    files.push({ asset, base64: Buffer.from(bytes).toString("base64") });
  };
  for (const source of input.sources) {
    const asset = ImmutableAssetRefSchema.parse(source.asset);
    if (!source.sourcePath || path.isAbsolute(source.sourcePath)) throw new Error(`Taskset asset ${asset.id} requires a relative source path.`);
    const localPath = path.resolve(root, source.sourcePath);
    if (!localPath.startsWith(`${root}${path.sep}`)) throw new Error(`Taskset asset ${asset.id} escapes its local package.`);
    const resolved = await realpath(localPath);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Taskset asset ${asset.id} escapes its local package.`);
    const handle = await open(localPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const status = await handle.stat();
      if (!status.isFile() || status.size !== asset.sizeBytes) throw new Error(`Taskset asset ${asset.id} differs from its immutable file size.`);
      if (4 * Math.ceil(status.size / 3) + encodedBytes > MAX_TASKSET_PACKAGE_BYTES) throw new Error("Local Taskset files exceed the package envelope.");
      // A bounded read prevents a concurrently growing file from allocating an
      // unbounded buffer. Final contract validation also checks the byte hash.
      const bytes = Buffer.alloc(status.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw new Error(`Taskset asset ${asset.id} changed during capture.`);
        offset += read.bytesRead;
      }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
      if (extra.bytesRead) throw new Error(`Taskset asset ${asset.id} changed during capture.`);
      append(asset, bytes);
    } finally {
      await handle.close();
    }
  }
  for (const resource of input.content.modelResources?.assets ?? []) {
    if (identities.has(resource.asset.id)) continue;
    append(resource.asset, Buffer.from(verifyLearningTextAsset(resource, resource.asset), "utf8"));
  }
  if (input.fileOrder) {
    if (new Set(input.fileOrder).size !== files.length || input.fileOrder.length !== files.length || input.fileOrder.some(id => !identities.has(id))) throw new Error("Saved package file order differs from its inventory.");
    const positions = new Map(input.fileOrder.map((id, index) => [id, index]));
    files.sort((left, right) => positions.get(left.asset.id)! - positions.get(right.asset.id)!);
  }
  return createTasksetPackage({ ...input.content, files });
}
