import type { TasksetRelease } from "@openpond/evals/tasksets";
import { LearningTextAssetSchema, sealLearningContent, type LearningTextAsset } from "@openpond/evals/learning";
import { createModelStarterExecutionAsset, modelStarterExecutionAssetId, ModelStarterExecutionSchema, validateModelStarterExecution, type ModelStarterExecution } from "./model-starter-execution.js";
import { decodeTasksetPackageFile, type TasksetPackageFile } from "./taskset-package-files.js";

/** Resolve the same private execution graph for bound and ordinary packages.
 * Package admission separately validates the enclosing release and file graph. */
export function resolveTasksetPackageExecution(input: {
  taskset: TasksetRelease;
  files: TasksetPackageFile[];
  modelResources?: { execution?: ModelStarterExecution };
}): { execution: ModelStarterExecution; assets: LearningTextAsset[] } | null {
  if (input.taskset.environment.entrypoint !== "openpond.javascript-environment.v1") return null;
  const byId = new Map(input.files.map(file => [file.asset.id, file]));
  const read = (id: string): LearningTextAsset => {
    const file = byId.get(id);
    if (!file) throw new Error(`Taskset environment asset is missing: ${id}.`);
    if (file.asset.sizeBytes > 524_288) throw new Error("Taskset environment source exceeds the authored asset limit.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decodeTasksetPackageFile(file));
    return LearningTextAssetSchema.parse(sealLearningContent({ schemaVersion: "openpond.learningTextAsset.v1", id, revision: 1, asset: file.asset, text }));
  };
  let execution: ModelStarterExecution;
  if (input.modelResources) {
    if (!input.modelResources.execution) throw new Error("Bound Taskset JavaScript execution resources are missing.");
    execution = ModelStarterExecutionSchema.parse(input.modelResources.execution);
  } else {
    const declaration = read(modelStarterExecutionAssetId(input.taskset));
    if (declaration.asset.visibility !== "host_private" || declaration.asset.mediaType !== "application/json" || declaration.asset.path !== "environment/execution.json") throw new Error("Taskset execution declaration must be private JSON at environment/execution.json.");
    execution = ModelStarterExecutionSchema.parse(JSON.parse(declaration.text));
  }
  const ids = new Set([execution.javascript.module.id,
    ...[execution.environment.actionSchemaRef, execution.environment.observationSchemaRef, execution.environment.stateSchemaRef].flatMap(ref => ref ? [ref.id] : []),
    ...input.taskset.tasks.flatMap(task => task.privilegedContextRef ? [task.privilegedContextRef] : []),
  ]);
  const assets = [...ids].map(read);
  validateModelStarterExecution(execution, input.taskset, assets);
  return { execution, assets };
}

/** Regenerate the declaration when publication reseals its execution releases. */
export function createTasksetPackageExecutionFile(execution: ModelStarterExecution): TasksetPackageFile {
  const asset = createModelStarterExecutionAsset(execution);
  const bytes = new TextEncoder().encode(asset.text);
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return { asset: asset.asset, base64: btoa(raw) };
}
