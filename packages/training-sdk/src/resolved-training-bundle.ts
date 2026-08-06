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
  HarnessRunManifestContentSchema,
  HarnessRunManifestSchema,
  ImmutableReleaseRefSchema,
  ResolvedTrainingBundleContentSchema,
  ResolvedTrainingBundleManifestSchema,
  type ComputeTargetBinding,
  type HarnessRunManifest,
  type HarnessRuntimeTargetBinding,
  type ImmutableReleaseRef,
  type ModelRunDraft,
  type OpaqueSecretLeaseRef,
  type ResolvedTrainingBundleManifest,
  type Taskset,
  type TrainingEngineBinding,
  type VersionedReleaseRef,
} from "@openpond/contracts";
import {
  canonicalJson,
  computeTasksetHash,
  contentHash,
  sha256,
} from "@openpond/taskset-sdk";

export type TasksetTrainingBundle = {
  manifest: HarnessRunManifest;
  resolvedBundleManifest: ResolvedTrainingBundleManifest;
  assets: ReadonlyMap<string, Uint8Array>;
  profileRelease: VersionedReleaseRef;
  harnessRelease: ImmutableReleaseRef;
  tasksetRelease: ImmutableReleaseRef;
  datasetRelease: ImmutableReleaseRef;
  evidenceSetRelease: ImmutableReleaseRef | null;
};

/**
 * Produces the one artifact the training worker consumes. The release refs in
 * the manifest are immutable lineage identifiers, not separately materialized
 * release objects.
 */
export function buildTasksetTrainingBundle(input: {
  taskset: Taskset;
  modelRun: ModelRunDraft;
  runtime: HarnessRuntimeTargetBinding;
  compute: ComputeTargetBinding;
  engine: TrainingEngineBinding;
  approval: {
    approvalHash: string;
    approvedAt: string;
    maximumSpendUsd: number | null;
  };
  secretLeaseRefs?: OpaqueSecretLeaseRef[];
  openpondRelease: string;
  workerProtocol: string;
  harnessRelease: ImmutableReleaseRef;
  tasksetRelease: ImmutableReleaseRef;
}): TasksetTrainingBundle {
  const { taskset, modelRun, harnessRelease, tasksetRelease } = input;
  const releasedHarness = ImmutableReleaseRefSchema.parse(harnessRelease);
  const releasedTaskset = ImmutableReleaseRefSchema.parse(tasksetRelease);
  // These remain part of the preparation API for adapter compatibility; the
  // selected Harness release is now supplied explicitly and is never rebuilt
  // from mutable Profile/Taskset state here.
  void input.openpondRelease;
  void input.workerProtocol;
  const actualTasksetHash = computeTasksetHash(taskset);
  if (actualTasksetHash !== taskset.contentHash) {
    throw new Error(
      "Taskset authoring state changed after its release was selected.",
    );
  }
  if (
    !modelRun.baseModel?.revision ||
    !modelRun.baseModel.tokenizerRevision ||
    !modelRun.baseModel.chatTemplateHash ||
    !modelRun.recipe ||
    !modelRun.tasksetRef ||
    modelRun.tasksetRef.id !== taskset.id ||
    modelRun.tasksetRef.contentHash !== taskset.contentHash
  ) {
    throw new Error(
      "Model Run must bind an exact Taskset, Model revision, tokenizer, chat template, and Recipe.",
    );
  }

  const profileRelease = taskset.profileRelease ?? {
    id: `profile_${taskset.profileId}`,
    revision: taskset.revision,
    contentHash: contentHash({
      profileId: taskset.profileId,
      sourceCommit: taskset.authoringProvenance.sourceCommit,
      skillHash: taskset.authoringProvenance.skillHash,
    }),
  };
  const assets = new Map<string, Uint8Array>();
  addJsonAsset(assets, "environment.json", {
    schemaVersion: "openpond.harnessEnvironment.v1",
    environment: taskset.environment,
    capabilities: taskset.capabilities,
    policy: taskset.policy,
  });
  addJsonAsset(assets, "graders.json", {
    schemaVersion: "openpond.harnessGraders.v1",
    graders: taskset.graders,
    fixtures: taskset.graderFixtures,
  });
  addJsonAsset(assets, "tool-contract.json", {
    schemaVersion: "openpond.harnessToolContract.v1",
    toolNames: taskset.environment.toolNames,
    actionBindings: taskset.environment.actionBindings ?? [],
    capabilities: taskset.capabilities,
    connectedAppScopes: taskset.policy.connectedAppScopes,
  });

  const trainTasks = taskset.tasks.filter((task) => task.split === "train");
  if (trainTasks.length > 0) {
    addJsonAsset(assets, "dataset/train.json", {
      schemaVersion: "openpond.datasetSplit.v1",
      split: "train",
      tasks: trainTasks,
    });
  } else if (taskset.datasetArtifact) {
    addJsonAsset(assets, "dataset/artifact.json", taskset.datasetArtifact);
  } else {
    throw new Error("Taskset has no training dataset.");
  }

  const approvedSignals = Object.values(taskset.learningSignals)
    .flat()
    .filter((signal) => signal.approved);
  for (const signal of approvedSignals) {
    const value = bytes(signal);
    assets.set(`evidence/signals/${sha256(value)}.json`, value);
  }

  const datasetRelease = {
    id: `dataset_${taskset.id}_r${taskset.revision}`,
    contentHash: contentHash({
      taskset: releasedTaskset,
      sourceRefs: taskset.sourceRefs,
      datasetArtifact: taskset.datasetArtifact ?? null,
      trainTasks,
    }),
  };
  const evidenceSetRelease =
    approvedSignals.length > 0
      ? {
          id: `evidence_${taskset.id}_r${taskset.revision}`,
          contentHash: contentHash({
            taskset: releasedTaskset,
            harnessRelease: releasedHarness,
            datasetRelease,
            profileRelease,
            signals: approvedSignals,
          }),
        }
      : null;

  const bundleContent = ResolvedTrainingBundleContentSchema.parse({
    schemaVersion: "openpond.resolvedTrainingBundle.v1",
    projection: "trainer",
    harnessRelease: releasedHarness,
    datasetRelease,
    evidenceSetRelease,
    files: [...assets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([assetPath, value]) => ({
        path: assetPath,
        sha256: sha256(value),
        sizeBytes: value.byteLength,
      })),
  });
  const resolvedBundleManifest = ResolvedTrainingBundleManifestSchema.parse({
    ...bundleContent,
    contentHash: contentHash(bundleContent),
  });
  const manifestContent = HarnessRunManifestContentSchema.parse({
    schemaVersion: "openpond.harnessRunManifest.v1",
    id: `manifest_${modelRun.id}_${input.approval.approvalHash.slice(0, 16)}`,
    harnessRelease,
    datasetRelease,
    evidenceSets: evidenceSetRelease ? [evidenceSetRelease] : [],
    model: {
      source: modelRun.baseModel.modelId,
      revision: modelRun.baseModel.revision,
      artifactHash: null,
      tokenizerRevision: modelRun.baseModel.tokenizerRevision,
      chatTemplateHash: modelRun.baseModel.chatTemplateHash,
    },
    recipe: {
      method: modelRun.recipe.method,
      version: "openpond.trainingRecipe.v1",
      configHash: contentHash(modelRun.recipe),
    },
    runtimeTarget: input.runtime,
    computeTarget: input.compute,
    engine: input.engine,
    resolvedBundleHash: resolvedBundleManifest.contentHash,
    secretLeaseRefs: input.secretLeaseRefs ?? [],
    approval: input.approval,
    createdAt: modelRun.updatedAt,
  });
  const manifest = HarnessRunManifestSchema.parse({
    ...manifestContent,
    contentHash: contentHash(manifestContent),
  });
  return {
    manifest,
    resolvedBundleManifest,
    assets,
    profileRelease,
    harnessRelease: releasedHarness,
    tasksetRelease: releasedTaskset,
    datasetRelease,
    evidenceSetRelease,
  };
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

function addJsonAsset(
  assets: Map<string, Uint8Array>,
  assetPath: string,
  value: unknown,
): void {
  assets.set(assetPath, bytes(value));
}

function bytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
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
