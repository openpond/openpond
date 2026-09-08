import { readFile } from "node:fs/promises";
import path from "node:path";

import { HarnessRunManifestSchema } from "@openpond/contracts";
import { assertContentHash, resolveHarnessSourceSelection, sha256 } from "@openpond/harness";
import { verifyResolvedTrainingBundle } from "@openpond/training-sdk";

/** Restore the admitted source from the content-addressed run bundle. The
 * mutable Model selection and personal Harness channel are never consulted. */
export async function loadManagedRlHarnessSource(input: { storeDir: string; manifestHash: string }) {
  if (!/^[a-f0-9]{64}$/.test(input.manifestHash)) throw new Error("Managed local execution requires its exact run manifest hash.");
  const root = path.join(input.storeDir, "training", "portable-releases");
  const manifest = HarnessRunManifestSchema.parse(JSON.parse(await readFile(path.join(root, "manifests", `${input.manifestHash}.json`), "utf8")));
  assertContentHash(manifest, "Managed local Harness manifest");
  if (manifest.contentHash !== input.manifestHash) throw new Error("Managed local Harness manifest changed.");
  const directory = path.join(root, "resolved-bundles", manifest.resolvedBundleHash);
  const bundle = await verifyResolvedTrainingBundle(directory);
  if (bundle.contentHash !== manifest.resolvedBundleHash) throw new Error("Managed local Harness bundle differs from its run manifest.");
  const readAsset = async (assetPath: string) => {
    const entry = bundle.files.find(file => file.path === assetPath);
    if (!entry) throw new Error(`Managed local Harness bundle is missing ${assetPath}.`);
    const bytes = await readFile(path.join(directory, assetPath));
    if (bytes.byteLength !== entry.sizeBytes || sha256(bytes) !== entry.sha256) throw new Error("Managed local Harness source changed during admission.");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  };
  return resolveHarnessSourceSelection({
    selection: await readAsset("harness/execution.json"),
    sourcePackage: bundle.files.some(file => file.path === "harness/source-package.json")
      ? await readAsset("harness/source-package.json") : undefined,
    expectedRelease: manifest.harnessRelease,
  });
}
