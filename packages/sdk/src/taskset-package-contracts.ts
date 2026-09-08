import { z } from "zod";
import { contentHash, type ImmutableAssetRef } from "@openpond/harness";
import { EnvironmentReleaseSchema, VerifierSetReleaseSchema, verifyEnvironmentRelease, verifyVerifierSetRelease } from "@openpond/evals";
import { assertTasksetRelease, TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { ModelTasksetPackageSchema, validateModelTasksetPackage } from "./model-taskset-derivation.js";
import { taskBatchPackageMetadata } from "@openpond/evals/learning";
import { TasksetPackageLearningResourcesSchema, learningPackageContextFiles, validateTasksetLearningResources } from "./taskset-package-learning.js";
import { assertModelTasksetAuthoring } from "./model-taskset-authoring-lineage.js";
import { resolveTasksetPackageExecution } from "./taskset-package-execution.js";
import { MAX_TASKSET_PACKAGE_BYTES, TasksetPackageFileSchema, decodeTasksetPackageFile } from "./taskset-package-files.js";
export { MAX_TASKSET_PACKAGE_BYTES, TasksetPackageFileSchema, decodeTasksetPackageFile } from "./taskset-package-files.js";
export { resolveTasksetPackageExecution, createTasksetPackageExecutionFile } from "./taskset-package-execution.js";

const BoundModelResourcesSchema = ModelTasksetPackageSchema.omit({ taskset: true, executionResources: true });
export const TasksetPackageContentSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetPackage.v1"),
  taskset: TasksetReleaseSchema,
  environment: EnvironmentReleaseSchema,
  verifierSet: VerifierSetReleaseSchema,
  files: z.array(TasksetPackageFileSchema).max(10_000),
  modelResources: BoundModelResourcesSchema.optional(),
  learningResources: TasksetPackageLearningResourcesSchema.optional(),
}).strict();
export const TasksetPackageSchema = TasksetPackageContentSchema.extend({ contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type TasksetPackage = z.infer<typeof TasksetPackageSchema>;

/** The selected binding belongs to the package's declared authoring graph. */
export function tasksetPackageRewardBinding(value: TasksetPackage) {
  return value.learningResources ? taskBatchPackageMetadata(value.taskset).binding : value.modelResources?.rewardBinding ?? null;
}

/** Instructions follow the admitted authoring graph. An ordinary package with
 * no instructions declares an empty prompt, never its display name. */
export function resolveTasksetPackageInstructions(value: Pick<TasksetPackage, "taskset" | "modelResources" | "learningResources">): string {
  if (value.learningResources) return taskBatchPackageMetadata(value.taskset).definition.instructions;
  if (value.modelResources) return value.modelResources.taskDefinition.instructions;
  const authoring = z.object({ instructions: z.string().max(20_000).optional() }).passthrough()
    .parse(value.taskset.metadata.ordinaryAuthoring ?? {});
  return authoring.instructions ?? "";
}

/** Admission verifies the complete declared dependency graph, not readiness or
 * permission to execute it. Hosts separately authorize the workspace/project. */
export function validateTasksetPackage(value: unknown): TasksetPackage {
  assertBoundedTaskJson(value, MAX_TASKSET_PACKAGE_BYTES);
  const result = TasksetPackageSchema.parse(value);
  const { contentHash: hash, ...content } = result;
  if (contentHash(content) !== hash) throw new Error("Taskset package content hash differs from its bytes.");
  const { taskset, environment, verifierSet } = result;
  assertTasksetRelease(taskset);
  const authoring = assertModelTasksetAuthoring(taskset);
  if (authoring && (result.modelResources || result.learningResources)) throw new Error("Taskset package cannot declare competing authoring graphs.");
  if (!verifyEnvironmentRelease(environment) || !verifyVerifierSetRelease(verifierSet)
    || !same(taskset.environmentRelease, { id: environment.id, contentHash: environment.contentHash })
    || !same(taskset.verifierSetRelease, { id: verifierSet.id, contentHash: verifierSet.contentHash })
    || !same(taskset.environment, environment.contract) || !same(taskset.graders, verifierSet.graders)) {
    throw new Error("Taskset package execution releases do not match its Taskset.");
  }
  const files = new Map<string, z.infer<typeof TasksetPackageFileSchema>>();
  for (const file of result.files) {
    if (files.has(file.asset.id)) throw new Error(`Duplicate Taskset asset identity: ${file.asset.id}.`);
    decodeTasksetPackageFile(file);
    files.set(file.asset.id, file);
  }
  function requireAsset(ref: ImmutableAssetRef) {
    const file = files.get(ref.id);
    if (!file || !same(file.asset, ref)) throw new Error(`Taskset package asset is missing or mismatched: ${ref.id}.`);
  }
  for (const task of taskset.tasks) {
    for (const asset of task.artifactRefs) requireAsset(asset);
    for (const output of task.requiredOutputs ?? []) if (output.schemaRef) requireAsset(output.schemaRef);
    if (task.privilegedContextRef && files.get(task.privilegedContextRef)?.asset.visibility !== "host_private") {
      throw new Error(`Taskset package private context is missing: ${task.id}.`);
    }
  }
  for (const ref of [environment.actionSchemaRef, environment.observationSchemaRef, environment.stateSchemaRef]) if (ref) requireAsset(ref);
  for (const grader of taskset.graders) {
    const ref = "verifierRef" in grader ? grader.verifierRef : "rubricRef" in grader ? grader.rubricRef : null;
    if (ref) {
      requireAsset(ref);
      if (ref.visibility === "policy") throw new Error(`Taskset grader asset must be private: ${ref.id}.`);
    }
  }
  if (taskset.metrics?.customAggregator) {
    const aggregator = taskset.metrics.customAggregator;
    const modules = result.files.filter(file => file.asset.path === aggregator.module);
    if (modules.length !== 1 || modules[0]!.asset.contentHash !== aggregator.contentHash || modules[0]!.asset.sizeBytes > 524_288 || modules[0]!.asset.visibility === "policy") {
      throw new Error("Taskset metric module is missing or mismatched, public, or exceeds the source limit.");
    }
  }
  for (const declarations of [taskset.metadata.environmentResources, environment.metadata.resources]) {
    if (declarations === undefined) continue;
    for (const resource of z.array(z.object({ path: z.string().min(1) }).passthrough()).parse(declarations)) {
      if (!result.files.some(file => file.asset.path === resource.path)) throw new Error(`Taskset environment resource is missing: ${resource.path}.`);
    }
  }
  if (result.learningResources) {
    if (result.modelResources) throw new Error("Taskset package cannot declare competing authoring graphs.");
    const learning = validateTasksetLearningResources(taskset, result.learningResources);
    for (const expected of learningPackageContextFiles(learning)) {
      if (!same(files.get(expected.asset.id), expected)) throw new Error("Taskset private context differs from its reviewed evidence.");
    }
    for (const asset of learning.assets) requireAsset(asset.asset);
  } else if (result.modelResources) {
    const model = validateModelTasksetPackage({ ...result.modelResources, taskset, executionResources: { environment, verifierSet } });
    for (const asset of model.assets) requireAsset(asset.asset);
  } else if (["starter", "rewardBinding", "rewardExecution", "modelTasksetDerivation", "learning"].some(key => taskset.metadata[key] !== undefined)) {
    throw new Error("Bound Taskset publication requires its complete model resources.");
  }
  resolveTasksetPackageExecution(result);
  resolveTasksetPackageInstructions(result);
  return result;
}

export function createTasksetPackage(value: z.input<typeof TasksetPackageContentSchema>): TasksetPackage {
  assertBoundedTaskJson(value, MAX_TASKSET_PACKAGE_BYTES);
  const content = TasksetPackageContentSchema.parse(value);
  return validateTasksetPackage({ ...content, contentHash: contentHash(content) });
}

function same(left: unknown, right: unknown): boolean {
  return contentHash({ value: left }) === contentHash({ value: right });
}
