import { createHash } from "node:crypto";
import { contentHash } from "@openpond/harness";
import type { Taskset, TaskDataRecord } from "@openpond/contracts";
import {
  decodeTasksetPackageFile,
  type TasksetPackage,
} from "openpond-sdk/taskset-packages";
import type { ResolvedTasksetWorkAsset } from "./taskset-work-assets.js";
/** Published evaluation authorization is checked by the source owner. This
 * projection neither changes import consent nor makes private files visible. */
export function advancedPublishedWorkAssets(
  value: TasksetPackage,
  taskset: Taskset,
  task: TaskDataRecord,
): ResolvedTasksetWorkAsset[] {
  if (taskset.metadata.importedPackageHash !== value.contentHash)
    throw new Error(
      "The Work projection differs from the admitted published package.",
    );
  const original = value.taskset.tasks.find((row) => row.id === task.id);
  if (
    !original ||
    original.split !== task.split ||
    contentHash(task.metadata.portableTaskRecord) !== contentHash(original)
  )
    throw new Error(
      "The Work task differs from its exact released population.",
    );
  let total = 0;
  const result = (task.assets ?? []).map((asset) => {
    const ref = original.artifactRefs.find(
      (ref) =>
        ref.id === asset.id &&
        ref.contentHash === asset.sha256 &&
        ref.path === asset.artifactRef,
    );
    const file =
      ref &&
      value.files.find((file) => contentHash(file.asset) === contentHash(ref));
    if (!ref || !file || ref.visibility !== "policy")
      throw new Error(
        "The Work task requests an unavailable or private evaluator file.",
      );
    const bytes = Buffer.from(decodeTasksetPackageFile(file)),
      hash = createHash("sha256").update(bytes).digest("hex");
    if (
      hash !== asset.sha256 ||
      bytes.length !== asset.sizeBytes ||
      asset.split !== task.split
    )
      throw new Error("The published Work input manifest changed.");
    total += bytes.length;
    if (total > 250_000_000)
      throw new Error(
        "Published Work inputs exceed the admitted 250 MB ceiling.",
      );
    return {
      ...asset,
      assetId: asset.id,
      storageName: asset.fileName,
      bytes,
      sizeBytes: bytes.length,
    };
  });
  if (result.length !== original.artifactRefs.length)
    throw new Error(
      "The exact policy-visible Work asset population is incomplete.",
    );
  return result;
}
