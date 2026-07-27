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

import {
  HarnessExecutionBundleManifestSchema,
  HarnessReleaseSchema,
  ResolvedTrainingBundleManifestSchema,
  type HarnessBundleProjection,
  type HarnessExecutionBundleManifest,
  type HarnessRelease,
  type ResolvedTrainingBundleManifest,
} from "@openpond/contracts";
import { canonicalJson, contentHash, sha256 } from "@openpond/taskset-sdk";

import { validateHarnessRelease } from "./release-graph.js";
import type { HarnessAssetReader } from "./release-store.js";

export type HarnessMaterializationTarget = {
  adapterId: string;
  projection: HarnessBundleProjection;
  runtimeVersion: string;
  expectedContracts: HarnessRelease["requiredContracts"];
};

export async function materializeHarnessRelease(input: {
  release: HarnessRelease;
  cacheRoot: string;
  target: HarnessMaterializationTarget;
  readAsset: HarnessAssetReader;
}): Promise<{
  directory: string;
  manifest: HarnessExecutionBundleManifest;
  cacheHit: boolean;
}> {
  const release = HarnessReleaseSchema.parse(input.release);
  const issues = validateHarnessRelease(release);
  if (issues.length) {
    throw new Error(
      `Harness Release validation failed: ${issues.map((issue) => issue.code).join(", ")}`,
    );
  }
  assertContracts(release.requiredContracts, input.target.expectedContracts);
  const cacheKey = contentHash([
    release.contentHash,
    input.target.adapterId,
    input.target.projection,
    input.target.runtimeVersion,
  ]);
  const directory = path.join(input.cacheRoot, cacheKey);
  const manifestPath = path.join(directory, "bundle-manifest.json");
  if (await exists(manifestPath)) {
    const manifest = HarnessExecutionBundleManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    await verifyMaterializedBundle(directory, manifest);
    return { directory, manifest, cacheHit: true };
  }

  await mkdir(input.cacheRoot, { recursive: true });
  const temporary = path.join(
    input.cacheRoot,
    `.materializing-${cacheKey}-${process.pid}-${randomUUID()}`,
  );
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    const selected = release.assets
      .filter((asset) => asset.projections.includes(input.target.projection))
      .sort((left, right) => left.path.localeCompare(right.path));
    for (const asset of selected) {
      const bytes = await input.readAsset(asset);
      if (bytes.byteLength !== asset.sizeBytes || sha256(bytes) !== asset.sha256) {
        throw new Error(`Harness asset ${asset.path} failed materialization verification.`);
      }
      const target = path.join(temporary, ...asset.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { mode: asset.executable ? 0o700 : 0o600 });
    }
    const base = {
      schemaVersion: "openpond.harnessExecutionBundle.v1" as const,
      harnessRelease: { id: release.id, contentHash: release.contentHash },
      resolvedGraphHash: contentHash(
        release.children
          .map((child) => ({
            kind: child.kind,
            id: child.id,
            contentHash: child.contentHash,
            contractVersion: child.contractVersion,
          }))
          .sort((left, right) =>
            `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
          ),
      ),
      target: {
        adapterId: input.target.adapterId,
        projection: input.target.projection,
        runtimeVersion: input.target.runtimeVersion,
      },
      files: selected.map((asset) => ({
        ...asset,
        sourceReleaseId: release.id,
      })),
      actionBindings: (release.actionBindings ?? []).filter((binding) =>
        input.target.projection === "student"
          ? binding.studentVisible
          : input.target.projection === "orchestrator" ||
              input.target.projection === "environment" ||
              input.target.projection === "trainer"),
      secretDeclarations: release.secretDeclarations.filter(
        (declaration) =>
          declaration.audience === input.target.projection ||
          (declaration.audience === "infrastructure" &&
            input.target.projection === "infrastructure"),
      ),
    };
    const manifest = HarnessExecutionBundleManifestSchema.parse({
      ...base,
      contentHash: contentHash(base),
    });
    await writeFile(
      path.join(temporary, "bundle-manifest.json"),
      canonicalJson(manifest),
      { mode: 0o600 },
    );
    await rename(temporary, directory).catch(async (error) => {
      if (!(await exists(directory))) throw error;
    });
    const resolved = HarnessExecutionBundleManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    await verifyMaterializedBundle(directory, resolved);
    return { directory, manifest: resolved, cacheHit: false };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyMaterializedBundle(
  directory: string,
  manifest: HarnessExecutionBundleManifest,
): Promise<void> {
  const { contentHash: manifestHash, ...content } = manifest;
  if (contentHash(content) !== manifestHash) {
    throw new Error("Harness Execution Bundle manifest hash mismatch.");
  }
  const expectedFiles = new Set(["bundle-manifest.json"]);
  for (const file of manifest.files) {
    if (expectedFiles.has(file.path)) {
      throw new Error(
        `Harness Execution Bundle asset ${file.path} is duplicated or reserved.`,
      );
    }
    expectedFiles.add(file.path);
    const target = bundleAssetPath(directory, file.path, "Harness Execution Bundle");
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `Harness Execution Bundle asset ${file.path} is not a regular file.`,
      );
    }
    const bytes = await readFile(target);
    if (bytes.byteLength !== file.sizeBytes || sha256(bytes) !== file.sha256) {
      throw new Error(`Harness Execution Bundle asset ${file.path} changed.`);
    }
  }
  await assertExactFileInventory(directory, expectedFiles, "Harness Execution Bundle");
}

export async function materializeResolvedTrainingBundle(input: {
  manifest: ResolvedTrainingBundleManifest;
  assets: ReadonlyMap<string, Uint8Array>;
  cacheRoot: string;
}): Promise<{
  directory: string;
  manifest: ResolvedTrainingBundleManifest;
  cacheHit: boolean;
}> {
  const manifest = ResolvedTrainingBundleManifestSchema.parse(
    input.manifest,
  );
  validateResolvedTrainingBundleManifest(manifest);
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
      const bytes = input.assets.get(file.path);
      if (
        !bytes ||
        bytes.byteLength !== file.sizeBytes ||
        sha256(bytes) !== file.sha256
      ) {
        throw new Error(
          `Resolved Training Bundle asset ${file.path} failed verification.`,
        );
      }
      const target = resolvedBundleAssetPath(temporary, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { mode: 0o600 });
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
      await readFile(
        path.join(directory, "bundle-manifest.json"),
        "utf8",
      ),
    ),
  );
  const { contentHash: suppliedHash, ...content } = manifest;
  if (contentHash(content) !== suppliedHash) {
    throw new Error("Resolved Training Bundle manifest hash mismatch.");
  }
  if (
    expected &&
    canonicalJson(manifest) !== canonicalJson(expected)
  ) {
    throw new Error("Resolved Training Bundle manifest changed.");
  }
  validateResolvedTrainingBundleManifest(manifest);
  const expectedFiles = new Set(["bundle-manifest.json"]);
  for (const file of manifest.files) {
    expectedFiles.add(file.path);
    const target = resolvedBundleAssetPath(directory, file.path);
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `Resolved Training Bundle asset ${file.path} is not a regular file.`,
      );
    }
    const bytes = await readFile(target);
    if (
      bytes.byteLength !== file.sizeBytes ||
      sha256(bytes) !== file.sha256
    ) {
      throw new Error(
        `Resolved Training Bundle asset ${file.path} changed.`,
      );
    }
  }
  await assertExactFileInventory(directory, expectedFiles, "Resolved Training Bundle");
  return manifest;
}

function resolvedBundleAssetPath(root: string, assetPath: string): string {
  return bundleAssetPath(root, assetPath, "Resolved Training Bundle");
}

function bundleAssetPath(
  root: string,
  assetPath: string,
  label: string,
): string {
  if (
    assetPath.includes("\\") ||
    assetPath.includes("\0") ||
    path.posix.isAbsolute(assetPath) ||
    path.posix.normalize(assetPath) !== assetPath
  ) {
    throw new Error(`${label} asset ${assetPath} has an invalid path.`);
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
      `${label} asset ${assetPath} escapes its root.`,
    );
  }
  return target;
}

function validateResolvedTrainingBundleManifest(
  manifest: ResolvedTrainingBundleManifest,
): void {
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (
      file.path === "bundle-manifest.json" ||
      paths.has(file.path) ||
      file.path.includes("\\") ||
      file.path.includes("\0") ||
      path.posix.isAbsolute(file.path) ||
      path.posix.normalize(file.path) !== file.path
    ) {
      throw new Error(
        `Resolved Training Bundle asset ${file.path} is invalid, duplicated, or reserved.`,
      );
    }
    bundleAssetPath(
      "/__openpond_bundle_root__",
      file.path,
      "Resolved Training Bundle",
    );
    paths.add(file.path);
  }
}

async function assertExactFileInventory(
  directory: string,
  expected: ReadonlySet<string>,
  label: string,
): Promise<void> {
  const rootMetadata = await lstat(directory);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`${label} root is not a regular directory.`);
  }
  const actual = new Set<string>();
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const relative = path.relative(directory, target).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link at ${relative}.`);
      }
      if (entry.isDirectory()) {
        await visit(target);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`${label} contains a non-file entry at ${relative}.`);
      }
      actual.add(relative);
    }
  };
  await visit(directory);
  const missing = [...expected].filter((file) => !actual.has(file));
  const extra = [...actual].filter((file) => !expected.has(file));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} inventory changed (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`,
    );
  }
}

function assertContracts(
  actual: HarnessRelease["requiredContracts"],
  expected: HarnessRelease["requiredContracts"],
): void {
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `Harness contract ${key} requires ${actual[key]}, target provides ${expected[key]}.`,
      );
    }
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
