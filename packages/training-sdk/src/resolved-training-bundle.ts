import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { ResolvedTrainingBundleManifestSchema, type ResolvedTrainingBundleManifest } from "openpond-sdk/training-bundle";
import { canonicalJson, contentHash, sha256 } from "@openpond/harness";
export { buildTasksetTrainingBundle, type TasksetTrainingBundle } from "openpond-sdk/training-bundle";

export async function materializeResolvedTrainingBundle(input: {
  manifest: ResolvedTrainingBundleManifest;
  assets: ReadonlyMap<string, Uint8Array>;
  cacheRoot: string;
}): Promise<{
  directory: string;
  manifest: ResolvedTrainingBundleManifest;
  cacheHit: boolean;
}> {
  const manifest = ResolvedTrainingBundleManifestSchema.parse(input.manifest);
  validateBundleManifest(manifest);
  const directory = path.join(input.cacheRoot, manifest.contentHash);
  if (await exists(path.join(directory, "bundle-manifest.json"))) {
    await verifyResolvedTrainingBundle(directory, manifest);
    return { directory, manifest, cacheHit: true };
  }

  await mkdir(input.cacheRoot, { recursive: true });
  const temporary = path.join(
    input.cacheRoot,
    `.materializing-${manifest.contentHash}-${process.pid}-${randomUUID()}`,
  );
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    for (const file of manifest.files) {
      const value = input.assets.get(file.path);
      if (
        !value ||
        value.byteLength !== file.sizeBytes ||
        sha256(value) !== file.sha256
      ) {
        throw new Error(
          `Resolved Training Bundle asset ${file.path} failed verification.`,
        );
      }
      const target = bundleAssetPath(temporary, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, value, { mode: 0o600 });
    }
    await writeFile(
      path.join(temporary, "bundle-manifest.json"),
      canonicalJson(manifest),
      { mode: 0o600 },
    );
    await rename(temporary, directory).catch(async (error) => {
      if (!(await exists(directory))) throw error;
    });
    await verifyResolvedTrainingBundle(directory, manifest);
    return { directory, manifest, cacheHit: false };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyResolvedTrainingBundle(
  directory: string,
  expected?: ResolvedTrainingBundleManifest,
): Promise<ResolvedTrainingBundleManifest> {
  const manifest = ResolvedTrainingBundleManifestSchema.parse(
    JSON.parse(
      await readFile(path.join(directory, "bundle-manifest.json"), "utf8"),
    ),
  );
  const { contentHash: suppliedHash, ...content } = manifest;
  if (contentHash(content) !== suppliedHash) {
    throw new Error("Resolved Training Bundle manifest hash mismatch.");
  }
  if (expected && canonicalJson(manifest) !== canonicalJson(expected)) {
    throw new Error("Resolved Training Bundle manifest changed.");
  }
  validateBundleManifest(manifest);

  const expectedFiles = new Set(["bundle-manifest.json"]);
  for (const file of manifest.files) {
    expectedFiles.add(file.path);
    const target = bundleAssetPath(directory, file.path);
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `Resolved Training Bundle asset ${file.path} is not a regular file.`,
      );
    }
    const value = await readFile(target);
    if (value.byteLength !== file.sizeBytes || sha256(value) !== file.sha256) {
      throw new Error(`Resolved Training Bundle asset ${file.path} changed.`);
    }
  }
  await assertExactInventory(directory, expectedFiles);
  return manifest;
}

function validateBundleManifest(
  manifest: ResolvedTrainingBundleManifest,
): void {
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (file.path === "bundle-manifest.json" || paths.has(file.path)) {
      throw new Error(
        `Resolved Training Bundle asset ${file.path} is duplicated or reserved.`,
      );
    }
    bundleAssetPath("/__openpond_bundle_root__", file.path);
    paths.add(file.path);
  }
}

function bundleAssetPath(root: string, assetPath: string): string {
  if (
    assetPath.includes("\\") ||
    assetPath.includes("\0") ||
    path.posix.isAbsolute(assetPath) ||
    path.posix.normalize(assetPath) !== assetPath
  ) {
    throw new Error(
      `Resolved Training Bundle asset ${assetPath} has an invalid path.`,
    );
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(root, ...assetPath.split("/"));
  const relative = path.relative(resolvedRoot, target);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative === ""
  ) {
    throw new Error(
      `Resolved Training Bundle asset ${assetPath} escapes its root.`,
    );
  }
  return target;
}

async function assertExactInventory(
  directory: string,
  expected: ReadonlySet<string>,
): Promise<void> {
  const rootMetadata = await lstat(directory);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Resolved Training Bundle root is not a regular directory.");
  }
  const actual = new Set<string>();
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const relative = path.relative(directory, target).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Resolved Training Bundle contains a symbolic link at ${relative}.`,
        );
      }
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        actual.add(relative);
      } else {
        throw new Error(
          `Resolved Training Bundle contains a non-file entry at ${relative}.`,
        );
      }
    }
  };
  await visit(directory);
  const missing = [...expected].filter((file) => !actual.has(file));
  const extra = [...actual].filter((file) => !expected.has(file));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Resolved Training Bundle inventory changed (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`,
    );
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
