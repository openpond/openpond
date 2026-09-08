import { TasksetSchema, type GeneratedTaskFile, type Taskset } from "@openpond/contracts";
import { createEnvironmentRelease } from "@openpond/evals";
import { JavaScriptEnvironmentDefinitionSchema } from "@openpond/evals/javascript-environment";
import { learningRef, sealLearningContent } from "@openpond/evals/learning";
import { contentHash, type ImmutableAssetRef } from "@openpond/harness";
import { computeTasksetHash, materializePortableTasksetRelease, portableTasksetEnvironment } from "@openpond/taskset-sdk";
import { ModelStarterExecutionSchema } from "openpond-sdk/model-starters";
import { createTasksetPackageExecutionFile, decodeTasksetPackageFile } from "openpond-sdk/taskset-packages";
import { desktopTasksetRuntimeAdapterId } from "./portable-evals-adapter.js";

type Inventory = Array<{ asset: ImmutableAssetRef; sourcePath: string }>;

/** Source bytes change in the draft; publication owns all executable hashes.
 * The private declaration is regenerated with the newly compiled verifiers. */
export function prepareAuthoredToolEnvironment(taskset: Taskset, bytes: Map<string, Buffer>, inventory: Inventory): { taskset: Taskset; inventory: Inventory; generatedFiles: GeneratedTaskFile[] } {
  if (taskset.environment.entrypoint !== "openpond.javascript-environment.v1") return { taskset, inventory, generatedFiles: [] };
  const declarationPath = "environment/execution.json";
  const declaration = bytes.get(declarationPath);
  if (!declaration || declaration.length > 524_288) throw new Error("Authored tool environment requires its bounded private execution declaration.");
  const previous = ModelStarterExecutionSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(declaration)));
  const repin = (ref: ImmutableAssetRef | null): ImmutableAssetRef | null => {
    if (!ref) return null;
    const file = inventory.find(file => file.asset.id === ref.id && file.asset.path === ref.path);
    if (!file) throw new Error(`Authored environment dependency is missing: ${ref.id}.`);
    return file.asset;
  };
  const { contentHash: _javascriptHash, ...javascriptContent } = previous.javascript;
  const javascript = JavaScriptEnvironmentDefinitionSchema.parse(sealLearningContent({ ...javascriptContent,
    id: `javascript-${taskset.id}`, revision: taskset.revision, module: repin(previous.javascript.module),
  }));
  if (contentHash(javascript.tools) !== contentHash(taskset.environment.metadata.portableTools)
    || contentHash(javascript.tools.map(tool => tool.name)) !== contentHash(taskset.environment.toolNames)) throw new Error("Authored environment tools differ from the Taskset's declared tools.");
  const environment = createEnvironmentRelease({ schemaVersion: "openpond.environmentRelease.v1", id: `environment-${taskset.id}`, revision: taskset.revision,
    contract: portableTasksetEnvironment(taskset), actionSchemaRef: repin(previous.environment.actionSchemaRef), observationSchemaRef: repin(previous.environment.observationSchemaRef), stateSchemaRef: repin(previous.environment.stateSchemaRef),
    artifactCollection: previous.environment.artifactCollection, adapterConformanceHashes: {},
    metadata: { javascriptEnvironment: learningRef(javascript), resources: taskset.environment.resources ?? [] },
  });
  const prepared = TasksetSchema.parse({ ...taskset, environment: { ...taskset.environment,
    metadata: { ...taskset.environment.metadata, portableExecutionResources: { environment } },
  } });
  const releases = materializePortableTasksetRelease({ taskset: prepared, adapterId: desktopTasksetRuntimeAdapterId(prepared) });
  const file = createTasksetPackageExecutionFile({ javascript, environment, verifierSet: releases.verifierSetRelease });
  const nextInventory = [...inventory.filter(entry => entry.sourcePath !== declarationPath), { asset: file.asset, sourcePath: declarationPath }];
  const finalized = TasksetSchema.parse({ ...prepared, metadata: { ...prepared.metadata, portableFileInventory: nextInventory } });
  return { taskset: TasksetSchema.parse({ ...finalized, contentHash: computeTasksetHash(finalized) }), inventory: nextInventory,
    generatedFiles: [{ path: declarationPath, role: "environment", content: new TextDecoder().decode(decodeTasksetPackageFile(file)) }],
  };
}
