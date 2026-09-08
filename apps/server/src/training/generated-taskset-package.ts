import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { TasksetSchema, type GeneratedTaskFile, type Taskset } from "@openpond/contracts";
import { buildTaskset, computeTasksetHash, contentHash, hashTasksetDraftPackage } from "@openpond/taskset-sdk";
import { prepareAuthoredTasksetFiles } from "./authored-taskset-files.js";
import { materializeImmutableTasksetPackageAtRoot } from "./model-starter-package-files.js";
import { verifyPublishedTasksetAssets } from "./taskset-package-assets.js";

/** A generated revision gets its own immutable directory, just like a draft.
 * Building a later proposal must not overwrite an earlier run's verifier. */
export async function materializeGeneratedTasksetPackage(root: string, input: Taskset, generatedFiles: GeneratedTaskFile[]) {
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(path.join(root, ".authoring-"));
  try {
    await buildTaskset(input, temporary, { generatedFiles });
    return await materializeTasksetRevisionFromSource(root, input, temporary);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Preserve the complete source package while sealing a new manifest revision. */
export async function materializeTasksetRevisionFromSource(root: string, input: Taskset, sourceDirectory: string) {
    const packageHash = await hashTasksetDraftPackage(sourceDirectory);
    const prepared = await prepareAuthoredTasksetFiles(input, sourceDirectory);
    const directoryId = `authored-${contentHash(prepared.taskset)}`;
    const projected = TasksetSchema.parse({ ...prepared.taskset, environment: { ...prepared.taskset.environment,
      metadata: { ...prepared.taskset.environment.metadata, runtimeSourceTasksetId: directoryId } } });
    const taskset = TasksetSchema.parse({ ...projected, contentHash: computeTasksetHash(projected) });
    await materializeImmutableTasksetPackageAtRoot(root, { taskset, generatedFiles: prepared.generatedFiles }, directoryId, {
      source: { directory: sourceDirectory, packageHash },
      verify: directory => verifyPublishedTasksetAssets(directory, taskset),
    });
    return taskset;
}
