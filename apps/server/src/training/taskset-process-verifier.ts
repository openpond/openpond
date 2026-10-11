import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { Taskset, TaskAttemptResult } from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/harness";
import { materializePortableTasksetRelease, type CustomVerifierRunner } from "@openpond/taskset-sdk";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import type { SqliteStore } from "../store/store.js";
import { executeLocalProfileVerifier } from "../evaluations/profile-sandbox-verifier.js";
import { captureAuthoredModelTasksetPackage } from "./model-taskset-package-capture.js";
import { captureLocalTasksetPackage } from "./taskset-package-capture.js";
import { readCachedTasksetPackage } from "./taskset-package-files.js";
import { tasksetPackageDirectoryId } from "./taskset-package-path.js";
import { AuthoredTasksetFileInventorySchema } from "./authored-taskset-files.js";
import { desktopTasksetRuntimeAdapterId } from "./portable-evals-adapter.js";
import { localGraderFixtureArtifacts } from "./local-grader-fixture-artifacts.js";

type Artifacts = ReturnType<typeof localGraderFixtureArtifacts>;

export async function captureTasksetEvaluationPackage(storeDir: string, taskset: Taskset) {
  const releases = materializePortableTasksetRelease({ taskset, adapterId: desktopTasksetRuntimeAdapterId(taskset) });
  if (typeof taskset.metadata.importedPackageHash === "string") {
    const cached = await readCachedTasksetPackage(storeDir, taskset.metadata.importedPackageHash);
    if (cached.taskset.contentHash !== releases.tasksetRelease.contentHash) throw new Error("Evaluation Taskset differs from its pinned portable package.");
    const inventory = AuthoredTasksetFileInventorySchema.parse(taskset.metadata.portableFileInventory ?? []);
    const { files, contentHash: _hash, ...content } = cached;
    const captured = await captureLocalTasksetPackage({
      root: path.join(storeDir, "training", "tasksets", tasksetPackageDirectoryId(taskset)), content,
      sources: files.map(file => ({ asset: file.asset,
        sourcePath: inventory.find(entry => entry.asset.id === file.asset.id)?.sourcePath ?? file.asset.path })),
      fileOrder: files.map(file => file.asset.id),
    });
    if (captured.contentHash !== cached.contentHash) throw new Error("Evaluation package changed during capture.");
    return captured;
  }
  return captureAuthoredModelTasksetPackage({ storeDir, taskset, content: {
    schemaVersion: "openpond.tasksetPackage.v1", taskset: releases.tasksetRelease,
    environment: releases.environmentRelease, verifierSet: releases.verifierSetRelease,
  } });
}

/** Only the audit owner supplies this map. Claimed fixture metadata on a model
 * attempt never resolves private fixture bytes. Entries bind the entire attempt. */
export type TasksetFixtureEvidence = ReadonlyMap<string, { attemptHash: string; artifacts: Artifacts }>;

export function createTasksetProcessVerifier(input: {
  store: SqliteStore; storeDir: string; taskset: Taskset; packageValue: TasksetPackage;
  fixtures?: TasksetFixtureEvidence;
}): CustomVerifierRunner {
  return async ({ grader, task, attempt, signal }) => {
    const pinnedTask = input.taskset.tasks.find(candidate => candidate.id === task.id);
    const pinnedGrader = input.taskset.graders.find(candidate => candidate.id === grader.id);
    if (!pinnedTask || contentHash(pinnedTask) !== contentHash(task)
      || !pinnedGrader || contentHash(pinnedGrader) !== contentHash(grader)
      || attempt.tasksetId !== input.taskset.id || attempt.taskId !== task.id || attempt.split !== task.split) {
      throw new Error("Process grading differs from the selected Taskset revision or attempt.");
    }
    const releasedTask = input.packageValue.taskset.tasks.find(candidate => candidate.id === task.id);
    const releasedGrader = input.packageValue.taskset.graders.find(candidate => candidate.id === grader.id);
    if (!releasedTask || releasedGrader?.kind !== "custom_verifier" || releasedGrader.runtime !== "sandbox_process") {
      throw new Error("The process verifier is absent from the immutable package.");
    }
    const fixture = input.fixtures?.get(attempt.id);
    if (fixture && fixture.attemptHash !== contentHash(attempt)) throw new Error("Fixture attempt changed before private grading.");
    const artifacts = fixture?.artifacts ?? await readOwnedOutputArtifacts(input.store, input.storeDir, input.taskset, attempt);
    return executeLocalProfileVerifier({ packageValue: input.packageValue,
      grader: releasedGrader, task: releasedTask,
      evidence: { output: attempt.output, artifactRefs: attempt.artifactRefs,
        runtimeEventRefs: attempt.runtimeEventRefs, infrastructureError: attempt.infrastructureError, artifacts },
      signal, authorize: async () => { signal?.throwIfAborted(); },
    });
  };
}

/** Paths come solely from the execution owner's records. Read bounded regular
 * files without following links, and verify their complete immutable bytes. */
async function readOwnedOutputArtifacts(store: SqliteStore, storeDir: string, taskset: Taskset, attempt: TaskAttemptResult): Promise<Artifacts> {
  const records = await store.listTaskAttemptArtifacts({ attemptId: attempt.id });
  const artifacts: Artifacts = [];
  let total = 0;
  if (new Set(attempt.artifactRefs).size !== attempt.artifactRefs.length) throw new Error("Attempt contains duplicate artifact references.");
  for (const id of attempt.artifactRefs) {
    const matching = records.filter(record => record.id === id && record.tasksetId === taskset.id && record.taskId === attempt.taskId && record.attemptId === attempt.id);
    if (matching.length !== 1) throw new Error("Attempt artifact is not recorded by its execution owner.");
    const artifact = matching[0]!;
    if (artifact.kind !== "output_artifact") continue;
    if (artifacts.length >= 16 || (total += artifact.sizeBytes) > 20_000_000) throw new Error("Attempt artifacts exceed their byte boundary.");
    const home = await realpath(storeDir);
    const parent = await realpath(path.dirname(artifact.path));
    if (![path.join(home, "training/evaluation-artifacts"), path.join(home, "work/outputs")]
      .some(root => parent === root || parent.startsWith(`${root}${path.sep}`))) {
      throw new Error("Attempt artifact is outside the execution owner's output directories.");
    }
    const handle = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== artifact.sizeBytes) throw new Error("Owner-recorded artifact size changed.");
      bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw new Error("Owner-recorded artifact changed during capture.");
        offset += read.bytesRead;
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw new Error("Owner-recorded artifact changed during capture.");
    } finally { await handle.close(); }
    if (sha256(bytes) !== artifact.sha256) throw new Error("Owner-recorded artifact bytes changed.");
    artifacts.push({ reference: { id: artifact.id, contentHash: artifact.sha256, mediaType: artifact.mediaType ?? "application/octet-stream", sizeBytes: artifact.sizeBytes },
      title: path.basename(typeof artifact.metadata.requiredOutputPath === "string" ? artifact.metadata.requiredOutputPath : artifact.path),
      contentType: artifact.mediaType ?? "application/octet-stream", base64: bytes.toString("base64") });
  }
  return artifacts;
}
