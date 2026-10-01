import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  canonicalJson, contentHash, harnessSourcePackageFiles, sha256,
  validateHarnessSourcePackage, type HarnessSourcePackage,
} from "@openpond/harness";
import { HarnessWorkspaceSchema } from "@openpond/contracts";
import {
  StandaloneHarnessExperimentSourceSchema, type StandaloneHarnessExperimentSource,
} from "@openpond/evals/experiments";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import { LocalHarnessReleaseRecordSchema } from "../store/store-harness-release-record.js";
import { standaloneExperimentToolDeclarations } from "./standalone-experiment-tools.js";

/** Trusted owner provisioning, after origin authorization. Preserve published
 * Agent, Harness and file identities instead of recompiling an authoring folder.
 * This private workspace never becomes the user's selected Harness. */
export async function installPublishedExperimentSource(input: {
  store: HarnessStateStore;
  storeDir: string;
  ownerId: string;
  reference: StandaloneHarnessExperimentSource;
  sourcePackage: HarnessSourcePackage;
  createdAt: string;
}) {
  const reference = StandaloneHarnessExperimentSourceSchema.parse(input.reference);
  const source = validateHarnessSourcePackage(input.sourcePackage, reference.harnessRelease);
  if (source.contentHash !== reference.sourcePackageHash || contentHash(reference.agentSnapshot) !== contentHash({
    id: source.agentSnapshot.id, contentHash: source.agentSnapshot.contentHash,
  })) throw new Error("Published Experiment source differs from its admitted immutable closure.");
  if (!input.ownerId.trim()) throw new Error("Published Experiment source requires its trusted execution owner.");
  standaloneExperimentToolDeclarations(source);
  const workspaceId = `experiment-source-${contentHash({ ownerId: input.ownerId, reference })}`;
  const previous = await input.store.getHarnessReleaseRecord(reference.harnessRelease.contentHash);
  if (previous) {
    const workspace = await input.store.getHarnessWorkspace(previous.workspaceId);
    if (!workspace || workspace.id !== workspaceId || workspace.ownerScope.kind !== "personal"
      || workspace.ownerScope.id !== input.ownerId || workspace.metadata.experimentSourcePackageHash !== source.contentHash
      || contentHash(previous.agentSnapshot) !== contentHash(source.agentSnapshot)
      || contentHash(previous.harnessRelease) !== contentHash(source.harnessRelease)) {
      throw new Error("Published Experiment source is already retained under a different owner or immutable closure.");
    }
    await verifyBundle(previous.bundlePath, source);
    return { workspace, release: previous };
  }
  const root = path.join(input.storeDir, "library", "harnesses", "releases");
  const destination = path.join(root, source.harnessRelease.contentHash);
  const temporary = path.join(root, `.${source.harnessRelease.contentHash}.experiment-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(path.join(temporary, "source"), { recursive: true, mode: 0o700 });
    for (const [relative, bytes] of harnessSourcePackageFiles(source)) {
      const target = path.join(temporary, "source", ...relative.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
    for (const [name, value] of [["agent-snapshot.json", source.agentSnapshot], ["harness-release.json", source.harnessRelease]] as const)
      await fs.writeFile(path.join(temporary, name), canonicalJson(value), { flag: "wx", mode: 0o600 });
    try { await fs.rename(temporary, destination); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    await verifyBundle(destination, source);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  const release = LocalHarnessReleaseRecordSchema.parse({
    schemaVersion: "openpond.localHarnessReleaseRecord.v1", workspaceId,
    sourceRevision: source.contentHash, agentSnapshot: source.agentSnapshot,
    harnessRelease: source.harnessRelease, bundlePath: destination, createdAt: input.createdAt,
  });
  const workspace = HarnessWorkspaceSchema.parse({
    schemaVersion: "openpond.harnessWorkspace.v1", id: workspaceId,
    ownerScope: { kind: "personal", id: input.ownerId }, name: "Experiment source",
    location: "local", sourceRevision: source.contentHash, revision: 0, dirty: false,
    currentChannel: { name: "personal", release: reference.harnessRelease, revision: 1 },
    createdAt: input.createdAt, updatedAt: input.createdAt,
    metadata: { selectionEligible: false, experimentSourcePackageHash: source.contentHash },
  });
  await input.store.createHarnessWorkspaceWithRelease({ workspace, release });
  return { workspace, release };
}

async function verifyBundle(bundlePath: string, source: HarnessSourcePackage) {
  const actualRoot = await fs.realpath(bundlePath);
  if (actualRoot !== path.resolve(bundlePath)) throw new Error("Published Experiment bundle cannot be a symbolic link.");
  for (const [name, expected] of [["agent-snapshot.json", source.agentSnapshot], ["harness-release.json", source.harnessRelease]] as const) {
    const file = path.join(bundlePath, name);
    if (!(await fs.lstat(file)).isFile() || contentHash(JSON.parse(await fs.readFile(file, "utf8"))) !== contentHash(expected))
      throw new Error("Retained published Experiment release metadata changed.");
  }
  for (const asset of source.harnessRelease.files) {
    const file = path.join(bundlePath, "source", ...asset.path.split("/"));
    if (!(await fs.lstat(file)).isFile() || await fs.realpath(file) !== file)
      throw new Error("Published Experiment source must contain regular immutable files.");
    const bytes = await fs.readFile(file);
    if (bytes.byteLength !== asset.sizeBytes || sha256(bytes) !== asset.contentHash)
      throw new Error("Retained published Experiment source differs from its released bytes.");
  }
}
