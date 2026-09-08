import { readFile } from "node:fs/promises";
import path from "node:path";

import { HarnessRunManifestSchema } from "@openpond/contracts";
import { assertContentHash, resolveHarnessSourceSelection, sha256, type HarnessSourcePackage } from "@openpond/harness";
import { verifyResolvedTrainingBundle } from "@openpond/training-sdk";

/** Hosted artifact admission owns the exact executable tool/runtime contract.
 * Check client-known export boundaries before sending source to that endpoint. */
export function assertHostedTrainingHarnessSource(input: {
  environmentKind: string;
  sourcePackage: HarnessSourcePackage;
}): void {
  if (input.environmentKind !== "work") {
    throw new Error("Hosted selected Harness execution requires a Work Taskset.");
  }
  const portability = input.sourcePackage.agentSnapshot.portability;
  if (!portability.portable || portability.blockers.length > 0
    || portability.localOnlyAssetRefs.length > 0 || portability.hostPrivateAssetRefs.length > 0) {
    throw new Error("The selected Harness contains source that cannot be exported to hosted training.");
  }
  if (input.sourcePackage.harnessRelease.files.some(file => file.visibility !== "policy")) {
    throw new Error("Hosted selected Harness execution requires policy-visible source files.");
  }
}

/** Restore the admitted source from the content-addressed run bundle. The
 * mutable Model selection and personal Harness channel are never consulted. */
export async function loadTrainingHarnessSource(input: { storeDir: string; manifestHash: string }) {
  if (!/^[a-f0-9]{64}$/.test(input.manifestHash)) throw new Error("Local training execution requires its exact run manifest hash.");
  const root = path.join(input.storeDir, "training", "portable-releases");
  const manifest = HarnessRunManifestSchema.parse(JSON.parse(await readFile(path.join(root, "manifests", `${input.manifestHash}.json`), "utf8")));
  assertContentHash(manifest, "Local training Harness manifest");
  if (manifest.contentHash !== input.manifestHash) throw new Error("Local training Harness manifest changed.");
  const directory = path.join(root, "resolved-bundles", manifest.resolvedBundleHash);
  const bundle = await verifyResolvedTrainingBundle(directory);
  if (bundle.contentHash !== manifest.resolvedBundleHash) throw new Error("Local training Harness bundle differs from its run manifest.");
  const readAsset = async (assetPath: string) => {
    const entry = bundle.files.find(file => file.path === assetPath);
    if (!entry) throw new Error(`Local training Harness bundle is missing ${assetPath}.`);
    const bytes = await readFile(path.join(directory, assetPath));
    if (bytes.byteLength !== entry.sizeBytes || sha256(bytes) !== entry.sha256) throw new Error("Local training Harness source changed during admission.");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  };
  return resolveHarnessSourceSelection({
    selection: await readAsset("harness/execution.json"),
    sourcePackage: bundle.files.some(file => file.path === "harness/source-package.json")
      ? await readAsset("harness/source-package.json") : undefined,
    expectedRelease: manifest.harnessRelease,
  });
}
