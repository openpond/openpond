import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  canonicalJson,
  contentHash,
  type ImmutableReleaseRef,
} from "@openpond/harness";
import {
  DEFAULT_REFINER_REVIEW_PROFILE,
  REFINER_CORE_VERSION,
  RefinerBindingSchema,
  RefinerReleaseSchema,
  RefinerReviewProfileSchema,
  RefinerTransitionReceiptSchema,
  createRefinerRelease,
  serializeReviewProfile,
  type RefinerBinding,
  type RefinerRelease,
  type RefinerTransitionReceipt,
} from "@openpond/harness/refiner";
import {
  ActivateRefinerReleaseRequestSchema,
  RefinerHistoryPayloadSchema,
  UpdateRefinerProfileRequestSchema,
  type RefinerHistoryPayload,
} from "@openpond/contracts";

const CORE_PROMPT_IDENTITY = "OpenPond Refiner Core: evidence admission, privacy, ownership, validation, and immutable activation boundaries.";
const initializationByRoot = new Map<string, Promise<void>>();

export type RefinerProfilePaths = ReturnType<typeof refinerProfilePaths>;

export function refinerProfilePaths(storeDir: string) {
  const root = path.join(storeDir, "refiners");
  return {
    root,
    source: path.join(root, "source", "openpond.review.json"),
    releases: path.join(root, "releases"),
    transitions: path.join(root, "transitions"),
    binding: path.join(root, "binding.json"),
  };
}

export function createRefinerProfileRoutePayloads(storeDir: string) {
  const inspect = () => inspectRefinerProfile(storeDir);
  const update = (payload: unknown) => updateRefinerProfile(storeDir, payload);
  const activate = (payload: unknown) => activateRefinerRelease(storeDir, payload);
  const rollback = (payload: unknown) => rollbackRefinerRelease(storeDir, payload);
  return {
    refinerHistoryPayload: inspect,
    updateRefinerProfilePayload: update,
    activateRefinerReleasePayload: activate,
    rollbackRefinerReleasePayload: rollback,
    inspectRefiner: inspect,
    updateRefiner: update,
    activateRefiner: activate,
    rollbackRefiner: rollback,
  };
}

export async function inspectRefinerProfile(storeDir: string): Promise<RefinerHistoryPayload> {
  const paths = refinerProfilePaths(storeDir);
  await ensureInitialized(paths);
  const binding = RefinerBindingSchema.parse(await readJson(paths.binding));
  const releases = (await readDirectoryJson(paths.releases, RefinerReleaseSchema.parse))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const currentRelease = releases.find((release) =>
    release.id === binding.release.id && release.contentHash === binding.release.contentHash);
  if (!currentRelease) throw new Error("Active Refiner release is unavailable.");
  const transitions = (await readDirectoryJson(paths.transitions, RefinerTransitionReceiptSchema.parse))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return RefinerHistoryPayloadSchema.parse({
    rootPath: paths.root,
    sourcePath: paths.source,
    binding,
    currentRelease,
    releases,
    transitions,
  });
}

export async function loadActiveRefinerRelease(storeDir: string): Promise<RefinerRelease> {
  return (await inspectRefinerProfile(storeDir)).currentRelease;
}

export async function updateRefinerProfile(storeDir: string, payload: unknown): Promise<RefinerHistoryPayload> {
  const request = UpdateRefinerProfileRequestSchema.parse(payload);
  const paths = refinerProfilePaths(storeDir);
  await ensureInitialized(paths);
  const profile = RefinerReviewProfileSchema.parse(request.profile);
  const candidate = createRefinerRelease({
    profile,
    coreVersion: REFINER_CORE_VERSION,
    corePrompt: CORE_PROMPT_IDENTITY,
  });
  const existingReleases = await readDirectoryJson(paths.releases, RefinerReleaseSchema.parse);
  const release = existingReleases.find((item) =>
    item.composedPromptHash === candidate.composedPromptHash && item.profileHash === candidate.profileHash
  ) ?? candidate;
  await persistRelease(paths, release);
  await atomicWrite(paths.source, serializeReviewProfile(profile));
  const binding = RefinerBindingSchema.parse(await readJson(paths.binding));
  if (request.activate && binding.release.contentHash === release.contentHash) {
    return inspectRefinerProfile(storeDir);
  }
  if (!request.activate) {
    const transitions = await readDirectoryJson(paths.transitions, RefinerTransitionReceiptSchema.parse);
    const duplicateDraft = transitions.some((receipt) =>
      !receipt.bindingChanged
      && receipt.nextRelease.contentHash === release.contentHash
      && receipt.actor === request.actor
      && receipt.reason === request.reason
      && receipt.authoringSkillHash === request.authoringSkillHash
    );
    if (duplicateDraft) return inspectRefinerProfile(storeDir);
  }
  await transition(paths, release, {
    operation: "update",
    bindingChanged: request.activate,
    actor: request.actor,
    reason: request.reason,
    authoringSkillHash: request.authoringSkillHash,
  });
  return inspectRefinerProfile(storeDir);
}

export async function activateRefinerRelease(storeDir: string, payload: unknown): Promise<RefinerHistoryPayload> {
  const request = ActivateRefinerReleaseRequestSchema.parse(payload);
  const paths = refinerProfilePaths(storeDir);
  await ensureInitialized(paths);
  const release = await readRelease(paths, request.release);
  const binding = RefinerBindingSchema.parse(await readJson(paths.binding));
  if (binding.release.contentHash === release.contentHash) return inspectRefinerProfile(storeDir);
  await transition(paths, release, {
    operation: "activate",
    bindingChanged: true,
    actor: request.actor,
    reason: request.reason,
    authoringSkillHash: null,
  });
  await atomicWrite(paths.source, serializeReviewProfile(release.profile));
  return inspectRefinerProfile(storeDir);
}

export async function rollbackRefinerRelease(storeDir: string, payload: unknown): Promise<RefinerHistoryPayload> {
  const request = ActivateRefinerReleaseRequestSchema.parse(payload);
  const paths = refinerProfilePaths(storeDir);
  await ensureInitialized(paths);
  const release = await readRelease(paths, request.release);
  const binding = RefinerBindingSchema.parse(await readJson(paths.binding));
  if (binding.release.contentHash === release.contentHash) return inspectRefinerProfile(storeDir);
  await transition(paths, release, {
    operation: "rollback",
    bindingChanged: true,
    actor: request.actor,
    reason: request.reason,
    authoringSkillHash: null,
  });
  await atomicWrite(paths.source, serializeReviewProfile(release.profile));
  return inspectRefinerProfile(storeDir);
}

async function ensureInitialized(paths: RefinerProfilePaths): Promise<void> {
  const active = initializationByRoot.get(paths.root);
  if (active) return active;
  const initialization = initialize(paths);
  initializationByRoot.set(paths.root, initialization);
  try {
    await initialization;
  } catch (error) {
    initializationByRoot.delete(paths.root);
    throw error;
  }
}

async function initialize(paths: RefinerProfilePaths): Promise<void> {
  await Promise.all([
    fs.mkdir(path.dirname(paths.source), { recursive: true, mode: 0o700 }),
    fs.mkdir(paths.releases, { recursive: true, mode: 0o700 }),
    fs.mkdir(paths.transitions, { recursive: true, mode: 0o700 }),
  ]);
  if (await exists(paths.binding)) return;
  const release = createRefinerRelease({
    profile: DEFAULT_REFINER_REVIEW_PROFILE,
    coreVersion: REFINER_CORE_VERSION,
    corePrompt: CORE_PROMPT_IDENTITY,
  });
  await persistRelease(paths, release);
  await atomicWrite(paths.source, serializeReviewProfile(release.profile));
  await transition(paths, release, {
    operation: "initialize",
    bindingChanged: true,
    actor: "openpond",
    reason: "Initialize the default Refiner Review Profile.",
    authoringSkillHash: null,
  });
}

async function transition(
  paths: RefinerProfilePaths,
  release: RefinerRelease,
  input: Pick<RefinerTransitionReceipt, "operation" | "bindingChanged" | "actor" | "reason" | "authoringSkillHash">,
): Promise<void> {
  const previous = await exists(paths.binding)
    ? RefinerBindingSchema.parse(await readJson(paths.binding))
    : null;
  const now = new Date().toISOString();
  const releaseRef = immutableRef(release);
  const receiptWithoutHash = {
    schemaVersion: "openpond.refinerTransitionReceipt.v1" as const,
    id: `refiner-transition-${randomUUID()}`,
    operation: input.operation,
    bindingChanged: input.bindingChanged,
    previousRelease: previous?.release ?? null,
    nextRelease: releaseRef,
    actor: input.actor,
    reason: input.reason,
    authoringSkillHash: input.authoringSkillHash,
    validation: { valid: true, messages: [] },
    createdAt: now,
  };
  const receipt = RefinerTransitionReceiptSchema.parse({
    ...receiptWithoutHash,
    contentHash: contentHash(receiptWithoutHash),
  });
  await atomicWrite(path.join(paths.transitions, `${receipt.contentHash}.json`), canonicalJson(receipt));
  if (input.bindingChanged) {
    const binding: RefinerBinding = RefinerBindingSchema.parse({
      schemaVersion: "openpond.refinerBinding.v1",
      channel: "active",
      revision: (previous?.revision ?? -1) + 1,
      release: releaseRef,
      updatedAt: now,
    });
    await atomicWrite(paths.binding, canonicalJson(binding));
  }
}

async function persistRelease(paths: RefinerProfilePaths, release: RefinerRelease): Promise<void> {
  await atomicWrite(path.join(paths.releases, `${release.contentHash}.json`), canonicalJson(release), true);
}

async function readRelease(paths: RefinerProfilePaths, ref: ImmutableReleaseRef): Promise<RefinerRelease> {
  const release = RefinerReleaseSchema.parse(
    await readJson(path.join(paths.releases, `${ref.contentHash}.json`)),
  );
  if (release.id !== ref.id || release.contentHash !== ref.contentHash) {
    throw new Error("Refiner release reference does not match immutable release content.");
  }
  return release;
}

function immutableRef(release: RefinerRelease): ImmutableReleaseRef {
  return { id: release.id, contentHash: release.contentHash };
}

async function readDirectoryJson<T>(directory: string, parse: (value: unknown) => T): Promise<T[]> {
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
  return Promise.all(names.map(async (name) => parse(await readJson(path.join(directory, name)))));
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function atomicWrite(filePath: string, contents: string, preserveExisting = false): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (preserveExisting && await exists(filePath)) return;
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}
