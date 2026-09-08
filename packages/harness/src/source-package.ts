import { z } from "zod";

import {
  assertContentHash,
  contentHash,
  ImmutableAssetRefSchema,
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  sha256,
  type ImmutableAssetRef,
  type ImmutableReleaseRef,
} from "./common.js";
import { AgentSnapshotSchema, HarnessReleaseSchema, type AgentSnapshot, type HarnessRelease } from "./harness.js";

export const MAX_HARNESS_SOURCE_PACKAGE_BYTES = 25 * 1024 * 1024;

const HarnessSourceFileSchema = z.object({
  path: ImmutableAssetRefSchema.shape.path,
  base64: z.string().max(Math.ceil(MAX_HARNESS_SOURCE_PACKAGE_BYTES / 3) * 4),
}).strict();

const HarnessSourcePackageContentSchema = z.object({
  schemaVersion: z.literal("openpond.harnessSourcePackage.v1"),
  agentSnapshot: AgentSnapshotSchema,
  harnessRelease: HarnessReleaseSchema,
  files: z.array(HarnessSourceFileSchema).max(10_000),
}).strict();

export const HarnessSourcePackageSchema = HarnessSourcePackageContentSchema.extend({
  contentHash: ReleaseHashSchema,
}).strict();

export type HarnessSourcePackage = z.infer<typeof HarnessSourcePackageSchema>;

export const HarnessSourceSelectionSchema = z.object({
  schemaVersion: z.literal("openpond.harnessSourceSelection.v1"),
  mode: z.enum(["taskset_owned", "selected_release"]),
  harnessRelease: ImmutableReleaseRefSchema,
  sourcePackageHash: ReleaseHashSchema.nullable(),
}).strict().superRefine((selection, context) => {
  if ((selection.mode === "selected_release") !== (selection.sourcePackageHash !== null)) {
    context.addIssue({ code: "custom", path: ["sourcePackageHash"], message: "Only a selected release binds a source package." });
  }
});

export type HarnessSourceSelection = z.infer<typeof HarnessSourceSelectionSchema>;

/** Resolve the source selected by a captured bundle; missing source cannot be
 * interpreted as Taskset-owned execution when the bundle selected a release. */
export function resolveHarnessSourceSelection(input: {
  selection: unknown;
  sourcePackage?: unknown;
  expectedRelease: ImmutableReleaseRef;
}): { selection: HarnessSourceSelection; sourcePackage: HarnessSourcePackage | null } {
  const selection = HarnessSourceSelectionSchema.parse(input.selection);
  if (selection.harnessRelease.id !== input.expectedRelease.id
    || selection.harnessRelease.contentHash !== input.expectedRelease.contentHash) {
    throw new Error("Harness source selection differs from its run manifest.");
  }
  if (selection.mode === "taskset_owned") {
    if (input.sourcePackage !== undefined && input.sourcePackage !== null) throw new Error("Taskset-owned execution cannot include a selected Harness source package.");
    return { selection, sourcePackage: null };
  }
  const sourcePackage = validateHarnessSourcePackage(input.sourcePackage, selection.harnessRelease);
  if (sourcePackage.contentHash !== selection.sourcePackageHash) throw new Error("Harness source selection differs from its captured package.");
  return { selection, sourcePackage };
}

/** Capture the full released source. Runtime admission separately authorizes
 * export and capabilities; a source package never makes private files visible
 * to a policy merely by transporting them. */
export function createHarnessSourcePackage(input: {
  agentSnapshot: AgentSnapshot;
  harnessRelease: HarnessRelease;
  files: ReadonlyMap<string, Uint8Array>;
}): HarnessSourcePackage {
  if ([...input.files.values()].reduce((total, bytes) => total + bytes.byteLength, 0) > MAX_HARNESS_SOURCE_PACKAGE_BYTES) {
    throw new Error("Harness source package exceeds its byte limit.");
  }
  const content = HarnessSourcePackageContentSchema.parse({
    schemaVersion: "openpond.harnessSourcePackage.v1",
    agentSnapshot: input.agentSnapshot,
    harnessRelease: input.harnessRelease,
    files: [...input.files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({
      path,
      base64: encode(bytes),
    })),
  });
  return validateHarnessSourcePackage({ ...content, contentHash: contentHash(content) });
}

/** Validate both release objects, their complete asset closure and exact bytes.
 * Rehashing the outer package cannot bless a substituted instruction or file. */
export function validateHarnessSourcePackage(value: unknown, expected?: ImmutableReleaseRef): HarnessSourcePackage {
  const source = HarnessSourcePackageSchema.parse(value);
  assertContentHash(source, "Harness source package");
  assertContentHash(source.agentSnapshot, "Harness source Agent snapshot");
  assertContentHash(source.harnessRelease, "Harness source release");
  const { agentSnapshot, harnessRelease } = source;
  if (expected && (expected.id !== harnessRelease.id || expected.contentHash !== harnessRelease.contentHash)) {
    throw new Error("Harness source package differs from the selected release.");
  }
  if (harnessRelease.agentSnapshot.id !== agentSnapshot.id
    || harnessRelease.agentSnapshot.contentHash !== agentSnapshot.contentHash) {
    throw new Error("Harness source release does not bind its Agent snapshot.");
  }
  const assets = new Map<string, ImmutableAssetRef>();
  const ids = new Set<string>();
  for (const asset of harnessRelease.files) {
    if (asset.path.includes("\\") || asset.path.includes(":")) throw new Error("Harness source requires portable relative file paths.");
    if (assets.has(asset.path) || ids.has(asset.id)) throw new Error("Harness source contains duplicate asset paths or identities.");
    assets.set(asset.path, asset);
    ids.add(asset.id);
  }
  for (const asset of [harnessRelease.program, agentSnapshot.dependencyLock,
    ...agentSnapshot.instructions, ...agentSnapshot.skills, ...agentSnapshot.agents]) {
    if (contentHash(assets.get(asset.path) ?? null) !== contentHash(asset)) {
      throw new Error(`Harness source dependency ${asset.path} is absent or differs from its release inventory.`);
    }
  }
  for (const asset of [...agentSnapshot.instructions, ...agentSnapshot.skills]) {
    if (asset.visibility !== "policy") throw new Error(`Harness policy source ${asset.path} is private.`);
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of source.files) {
    if (paths.has(file.path)) throw new Error("Harness source package contains duplicate files.");
    paths.add(file.path);
    const asset = assets.get(file.path);
    if (!asset) throw new Error(`Harness source file ${file.path} is not declared by its release.`);
    const bytes = decode(file.base64);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_HARNESS_SOURCE_PACKAGE_BYTES) throw new Error("Harness source package exceeds its byte limit.");
    if (bytes.byteLength !== asset.sizeBytes || sha256(bytes) !== asset.contentHash) {
      throw new Error(`Harness source file ${file.path} differs from its immutable bytes.`);
    }
  }
  if (paths.size !== assets.size) throw new Error("Harness source package is missing released files.");
  return source;
}

/** Return an owned byte snapshot, including visibility in the release inventory.
 * A runtime must select policy assets explicitly rather than expose this map. */
export function harnessSourcePackageFiles(value: unknown, expected?: ImmutableReleaseRef): ReadonlyMap<string, Uint8Array> {
  const source = validateHarnessSourcePackage(value, expected);
  return new Map(source.files.map(file => [file.path, decode(file.base64)]));
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function decode(base64: string): Uint8Array {
  let binary: string;
  try { binary = atob(base64); } catch { throw new Error("Harness source file is not valid base64."); }
  if (btoa(binary) !== base64) throw new Error("Harness source file is not canonical base64.");
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
