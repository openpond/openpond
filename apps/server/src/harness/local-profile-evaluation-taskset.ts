import { computeTasksetHash, materializePortableTasksetRelease } from "@openpond/taskset-sdk";
import type { ProfileEvaluationDefinition } from "@openpond/evals";
import type { Taskset } from "@openpond/contracts";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";

import type { SqliteStore } from "../store/store.js";
import { desktopTasksetRuntimeAdapterId } from "../training/portable-evals-adapter.js";
import { captureAuthoredModelTasksetPackage } from "../training/model-taskset-package-capture.js";
import { cacheTasksetPackage, readCachedTasksetPackage } from "../training/taskset-package-files.js";

/** Resolve the frozen Taskset revision associated with a released evaluation.
 * Native sources are captured with their exact assets; imported sources are
 * read from the already verified portable package cache. */
export async function loadLocalProfileEvaluationTaskset(input: {
  store: SqliteStore;
  storeDir: string;
  definition: ProfileEvaluationDefinition;
  profileId: string;
}): Promise<TasksetPackage> {
  const expected = input.definition.tasksetRelease;
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
