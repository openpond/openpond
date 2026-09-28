import { withFileLock, storagePaths } from "@openpond/persistence";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  DEFAULT_REFINER_REVIEW_PROFILE,
  REFINER_CORE_VERSION,
  RefinerReviewProfileSchema,
  createRefinerRelease,
  serializeReviewProfile,
  type RefinerRelease,
} from "@openpond/harness/refiner";
import {
  ActivateRefinerReleaseRequestSchema,
  RefinerHistoryPayloadSchema,
  UpdateRefinerProfileRequestSchema,
  type RefinerHistoryPayload,
} from "@openpond/contracts";
import { createLocalRefinerProfileRepository } from "./refiner-profile-repository.js";

const CORE_PROMPT_IDENTITY = "OpenPond Refiner Core: evidence admission, privacy, ownership, validation, and immutable activation boundaries.";

export type RefinerProfilePaths = ReturnType<typeof refinerProfilePaths>;

export function refinerProfilePaths(storeDir: string) {
  const root = path.join(storeDir, "library", "refiners");
  return {
    home: storeDir,
    root,
    source: path.join(root, "source", "openpond.review.json"),
    releases: path.join(root, "releases"),
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
  const repository = createLocalRefinerProfileRepository(paths);
  const binding = repository.binding();
  if (!binding) throw new Error("Active Refiner binding is unavailable.");
  const releases = (await repository.releases())
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const currentRelease = releases.find((release) =>
    release.id === binding.release.id && release.contentHash === binding.release.contentHash);
  if (!currentRelease) throw new Error("Active Refiner release is unavailable.");
  const transitions = repository.transitions()
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
  return withFileLock(path.join(storagePaths(storeDir).runtime, "refiner-edit"), () => updateRefinerProfileUnlocked(storeDir, payload));
}
async function updateRefinerProfileUnlocked(storeDir: string, payload: unknown): Promise<RefinerHistoryPayload> {
  const request = UpdateRefinerProfileRequestSchema.parse(payload);
  const paths = refinerProfilePaths(storeDir);
  const repository = createLocalRefinerProfileRepository(paths);
  await ensureInitialized(paths);
  const profile = RefinerReviewProfileSchema.parse(request.profile);
  const candidate = createRefinerRelease({
    profile,
    coreVersion: REFINER_CORE_VERSION,
    corePrompt: CORE_PROMPT_IDENTITY,
  });
  const existingReleases = await repository.releases();
  const release = existingReleases.find((item) =>
    item.composedPromptHash === candidate.composedPromptHash && item.profileHash === candidate.profileHash
  ) ?? candidate;
  await repository.persistRelease(release);
  await repository.writeSource(serializeReviewProfile(profile));
  const binding = repository.binding();
  if (!binding) throw new Error("Active Refiner binding is unavailable.");
  if (request.activate && binding.release.contentHash === release.contentHash) {
    return inspectRefinerProfile(storeDir);
  }
  if (!request.activate) {
    const transitions = repository.transitions();
    const duplicateDraft = transitions.some((receipt) =>
      !receipt.bindingChanged
      && receipt.nextRelease.contentHash === release.contentHash
      && receipt.actor === request.actor
      && receipt.reason === request.reason
      && receipt.authoringSkillHash === request.authoringSkillHash
    );
    if (duplicateDraft) return inspectRefinerProfile(storeDir);
  }
  await repository.transition(release, {
    operation: "update",
    bindingChanged: request.activate,
    actor: request.actor,
    reason: request.reason,
    authoringSkillHash: request.authoringSkillHash,
  });
  return inspectRefinerProfile(storeDir);
}

export async function activateRefinerRelease(storeDir: string, payload: unknown): Promise<RefinerHistoryPayload> {
  return withFileLock(path.join(storagePaths(storeDir).runtime, "refiner-edit"), () => activateRefinerReleaseUnlocked(storeDir, payload));
}
async function activateRefinerReleaseUnlocked(storeDir: string, payload: unknown): Promise<RefinerHistoryPayload> {
  const request = ActivateRefinerReleaseRequestSchema.parse(payload);
  const paths = refinerProfilePaths(storeDir);
  const repository = createLocalRefinerProfileRepository(paths);
  await ensureInitialized(paths);
  const release = await repository.release(request.release);
  const binding = repository.binding();
  if (!binding) throw new Error("Active Refiner binding is unavailable.");
  if (binding.release.contentHash === release.contentHash) return inspectRefinerProfile(storeDir);
  await repository.transition(release, {
    operation: "activate",
    bindingChanged: true,
    actor: request.actor,
    reason: request.reason,
    authoringSkillHash: null,
  });
  await repository.writeSource(serializeReviewProfile(release.profile));
  return inspectRefinerProfile(storeDir);
}

export async function rollbackRefinerRelease(storeDir: string, payload: unknown): Promise<RefinerHistoryPayload> {
  return withFileLock(path.join(storagePaths(storeDir).runtime, "refiner-edit"), () => rollbackRefinerReleaseUnlocked(storeDir, payload));
}
async function rollbackRefinerReleaseUnlocked(storeDir: string, payload: unknown): Promise<RefinerHistoryPayload> {
  const request = ActivateRefinerReleaseRequestSchema.parse(payload);
  const paths = refinerProfilePaths(storeDir);
  const repository = createLocalRefinerProfileRepository(paths);
  await ensureInitialized(paths);
  const release = await repository.release(request.release);
  const binding = repository.binding();
  if (!binding) throw new Error("Active Refiner binding is unavailable.");
  if (binding.release.contentHash === release.contentHash) return inspectRefinerProfile(storeDir);
  await repository.transition(release, {
    operation: "rollback",
    bindingChanged: true,
    actor: request.actor,
    reason: request.reason,
    authoringSkillHash: null,
  });
  await repository.writeSource(serializeReviewProfile(release.profile));
  return inspectRefinerProfile(storeDir);
}

export async function initializeRefinerProfile(home: string): Promise<void> {
  await withFileLock(path.join(storagePaths(home).runtime, "refiner-initialize"), () => initialize(refinerProfilePaths(home)));
}
async function ensureInitialized(paths: RefinerProfilePaths): Promise<void> { await initializeRefinerProfile(paths.home); }

async function initialize(paths: RefinerProfilePaths): Promise<void> {
  const repository = createLocalRefinerProfileRepository(paths);
  await Promise.all([
    fs.mkdir(path.dirname(paths.source), { recursive: true, mode: 0o700 }),
    fs.mkdir(paths.releases, { recursive: true, mode: 0o700 }),
  ]);
  if (repository.binding()) return;
  const release = createRefinerRelease({
    profile: DEFAULT_REFINER_REVIEW_PROFILE,
    coreVersion: REFINER_CORE_VERSION,
    corePrompt: CORE_PROMPT_IDENTITY,
  });
  await repository.persistRelease(release);
  await repository.writeSource(serializeReviewProfile(release.profile));
  await repository.transition(release, {
    operation: "initialize",
    bindingChanged: true,
    actor: "openpond",
    reason: "Initialize the default Refiner Review Profile.",
    authoringSkillHash: null,
  });
}
