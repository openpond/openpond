import { computeTasksetHash, materializePortableTasksetRelease } from "@openpond/taskset-sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256 } from "@openpond/harness";
import type { ProfileEvaluationDefinition } from "@openpond/evals";
import type { Taskset } from "@openpond/contracts";
import { validateTasksetPackage, type TasksetPackage } from "openpond-sdk/taskset-packages";

import type { SqliteStore } from "../store/store.js";
import { desktopTasksetRuntimeAdapterId } from "../training/portable-evals-adapter.js";
import { captureAuthoredModelTasksetPackage } from "../training/model-taskset-package-capture.js";
import { cacheTasksetPackage, readCachedTasksetPackage } from "../training/taskset-package-files.js";
import { loadSelectedLocalHarnessRuntime } from "./local-harness-skill-runtime.js";

/** Resolve the frozen Taskset revision associated with a released evaluation.
 * Native sources are captured with their exact assets; imported sources are
 * read from the already verified portable package cache. */
export async function loadLocalProfileEvaluationTaskset(input: {
  store: SqliteStore;
  storeDir: string;
  definition: ProfileEvaluationDefinition;
  profileId: string;
  harnessRelease: { id: string; contentHash: string };
}): Promise<TasksetPackage> {
  const expected = input.definition.tasksetRelease;
  const runtime = await loadSelectedLocalHarnessRuntime(input.store, input.harnessRelease);
  if (!runtime) throw new Error("Evaluation Profile Harness release is unavailable.");
  const packagePath = `evals/tasksets/${expected.contentHash}.json`;
  const asset = runtime.release.harnessRelease.files.find((file) => file.path === packagePath);
  if (asset) {
    if (asset.visibility !== "verifier") throw new Error("Evaluation Taskset package is not verifier-private.");
    const bytes = await fs.readFile(path.join(runtime.release.bundlePath, "source", ...packagePath.split("/")));
    if (sha256(bytes) !== asset.contentHash) throw new Error("Released evaluation Taskset package bytes differ from their source receipt.");
    const packageValue = validateTasksetPackage(JSON.parse(bytes.toString("utf8")));
    if (packageValue.taskset.id !== expected.id || packageValue.taskset.contentHash !== expected.contentHash) {
      throw new Error("Released evaluation Taskset package differs from its definition.");
    }
    return packageValue;
  }
  const revisions = await input.store.listTasksetRevisions(input.profileId);
  for (const taskset of revisions) {
    if (expected.id !== taskset.id && expected.id !== `taskset-release-${taskset.id}-r${taskset.revision}`) continue;
    const packageValue = await loadCandidate(input.storeDir, taskset);
    if (packageValue.taskset.id === expected.id && packageValue.taskset.contentHash === expected.contentHash) {
      return packageValue;
    }
  }
  throw new Error(`Released Taskset ${expected.id} is unavailable in Profile ${input.profileId}.`);
}

async function loadCandidate(storeDir: string, taskset: Taskset): Promise<TasksetPackage> {
  const importedHash = taskset.metadata.importedPackageHash;
  if (typeof importedHash === "string") {
    const packageValue = await readCachedTasksetPackage(storeDir, importedHash);
    if (packageValue.taskset.id !== taskset.id || packageValue.taskset.revision !== taskset.revision) {
      throw new Error("Imported evaluation Taskset differs from its local Profile revision.");
    }
    return packageValue;
  }
  if (computeTasksetHash(taskset) !== taskset.contentHash) {
    throw new Error("Authored evaluation Taskset differs from its immutable revision.");
  }
  const releases = materializePortableTasksetRelease({
    taskset,
    adapterId: desktopTasksetRuntimeAdapterId(taskset),
  });
  const packageValue = await captureAuthoredModelTasksetPackage({
    storeDir,
    taskset,
    content: {
      schemaVersion: "openpond.tasksetPackage.v1",
      taskset: releases.tasksetRelease,
      environment: releases.environmentRelease,
      verifierSet: releases.verifierSetRelease,
    },
  });
  await cacheTasksetPackage(storeDir, packageValue);
  return packageValue;
}
