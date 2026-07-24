import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ResolvedTrainingPlan,
  WorkerResolvedBundle,
} from "@openpond/contracts";
import { verifyResolvedTrainingBundle } from "@openpond/training-sdk";

export async function resolveLocalConnectedWorkerBundle(input: {
  storeDir: string;
  plan: ResolvedTrainingPlan;
}): Promise<WorkerResolvedBundle> {
  const contentHash = input.plan.manifest.resolvedBundleHash;
  const directory = path.join(
    input.storeDir,
    "training",
    "portable-releases",
    "resolved-bundles",
    contentHash,
  );
  const manifest = await verifyResolvedTrainingBundle(directory);
  if (manifest.contentHash !== contentHash) {
    throw new Error(
      "Resolved Training Bundle does not match the connected worker plan.",
    );
  }
  const manifestSize = (
    await stat(path.join(directory, "bundle-manifest.json"))
  ).size;
  return {
    objectRef: pathToFileURL(directory).href,
    bundleContentHash: contentHash,
    sha256: contentHash,
    sizeBytes:
      manifestSize +
      manifest.files.reduce(
        (total, file) => total + file.sizeBytes,
        0,
      ),
    format: "directory",
  };
}
