import { TasksetSchema, type Taskset } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { computeTasksetHash, hashTasksetDraftPackage, materializePortableTasksetRelease } from "@openpond/taskset-sdk";
import { decodeTasksetPackageFile, publishModelTasksetDraftPackage, type ModelTasksetDraftPreparation } from "openpond-sdk/taskset-packages";
import { AuthoredTasksetFileInventorySchema } from "./authored-taskset-files.js";
import { captureLocalTasksetPackage } from "./taskset-package-capture.js";
import { cacheTasksetPackage } from "./taskset-package-files.js";
import { desktopTasksetRuntimeAdapterId } from "./portable-evals-adapter.js";
import { materializeImmutableTasksetPackage } from "./model-starter-package-files.js";
import { verifyPublishedTasksetAssets } from "./taskset-package-assets.js";

/** Compile the captured edited bytes through the public authoring contract.
 * Only the final native projection is eligible for atomic Model selection. */
export async function materializeModelTasksetDraftPublication(input: {
  home: string; directory: string; taskset: Taskset; preparation: ModelTasksetDraftPreparation;
}): Promise<{ directory: string; taskset: Taskset }> {
  const releases = materializePortableTasksetRelease({ taskset: input.taskset, adapterId: desktopTasksetRuntimeAdapterId(input.taskset) });
  const edited = await captureLocalTasksetPackage({ root: input.directory,
    content: { schemaVersion: "openpond.tasksetPackage.v1", taskset: releases.tasksetRelease, environment: releases.environmentRelease, verifierSet: releases.verifierSetRelease },
    sources: AuthoredTasksetFileInventorySchema.parse(input.taskset.metadata.portableFileInventory ?? []),
  });
  const compiled = publishModelTasksetDraftPackage({ preparation: input.preparation, edited });
  const previousInventory = AuthoredTasksetFileInventorySchema.parse(input.taskset.metadata.portableFileInventory ?? []);
  const inventory = compiled.files.map(file => ({ asset: file.asset,
    sourcePath: previousInventory.find(previous => previous.asset.id === file.asset.id)?.sourcePath ?? file.asset.path,
  }));
  const declaration = compiled.taskset.environment.entrypoint === "openpond.javascript-environment.v1"
    ? compiled.files.find(file => file.asset.path === "environment/execution.json") : undefined;
  const directoryId = `model-draft-${contentHash({ packageHash: compiled.contentHash, taskset: input.taskset })}`;
  const prepared = TasksetSchema.parse({ ...input.taskset, id: compiled.taskset.id, revision: compiled.taskset.revision,
    metadata: { ...input.taskset.metadata, portableFileInventory: inventory, importedPackageHash: compiled.contentHash, derivedPortableMetadata: compiled.taskset.metadata },
    environment: { ...input.taskset.environment, metadata: { ...input.taskset.environment.metadata,
      runtimeSourceTasksetId: directoryId, portableExecutionResources: { environment: compiled.environment, verifierSet: compiled.verifierSet } } },
  });
  const taskset = TasksetSchema.parse({ ...prepared, contentHash: computeTasksetHash(prepared) });
  const directory = await materializeImmutableTasksetPackage(input.home, { taskset, generatedFiles: declaration
    ? [{ path: declaration.asset.path, role: "environment", content: new TextDecoder("utf-8", { fatal: true }).decode(decodeTasksetPackageFile(declaration)) }] : [],
  }, directoryId, {
    source: { directory: input.directory, packageHash: await hashTasksetDraftPackage(input.directory) },
    verify: root => verifyPublishedTasksetAssets(root, taskset),
  });
  await cacheTasksetPackage(input.home, compiled);
  return { directory, taskset };
}
