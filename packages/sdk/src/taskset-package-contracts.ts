import { z } from "zod";
import { ImmutableAssetRefSchema, contentHash, sha256, type ImmutableAssetRef } from "@openpond/harness";
import { EnvironmentReleaseSchema, VerifierSetReleaseSchema, verifyEnvironmentRelease, verifyVerifierSetRelease } from "@openpond/evals";
import { assertTasksetRelease, TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { ModelTasksetPackageSchema, validateModelTasksetPackage } from "./model-taskset-derivation.js";

/** The limit covers the entire decoded JSON envelope, including base64. */
export const MAX_TASKSET_PACKAGE_BYTES = 64 * 1024 * 1024;
export const TasksetPackageFileSchema = z.object({
  asset: ImmutableAssetRefSchema,
  base64: z.string().max(Math.ceil(MAX_TASKSET_PACKAGE_BYTES / 3) * 4),
}).strict();
const BoundModelResourcesSchema = ModelTasksetPackageSchema.omit({ taskset: true, executionResources: true });
export const TasksetPackageContentSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetPackage.v1"),
  taskset: TasksetReleaseSchema,
  environment: EnvironmentReleaseSchema,
  verifierSet: VerifierSetReleaseSchema,
  files: z.array(TasksetPackageFileSchema).max(10_000),
  modelResources: BoundModelResourcesSchema.optional(),
}).strict();
export const TasksetPackageSchema = TasksetPackageContentSchema.extend({ contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type TasksetPackage = z.infer<typeof TasksetPackageSchema>;

export function decodeTasksetPackageFile(value: z.infer<typeof TasksetPackageFileSchema>): Uint8Array {
  const file = TasksetPackageFileSchema.parse(value);
  const raw = atob(file.base64);
  if (btoa(raw) !== file.base64) throw new Error(`Taskset asset ${file.asset.id} has noncanonical base64.`);
  const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
  if (bytes.byteLength !== file.asset.sizeBytes || sha256(bytes) !== file.asset.contentHash) throw new Error(`Taskset asset ${file.asset.id} differs from its immutable bytes.`);
  return bytes;
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
  for (const declarations of [taskset.metadata.environmentResources, environment.metadata.resources]) {
    if (declarations === undefined) continue;
    for (const resource of z.array(z.object({ path: z.string().min(1) }).passthrough()).parse(declarations)) {
      if (!result.files.some(file => file.asset.path === resource.path)) throw new Error(`Taskset environment resource is missing: ${resource.path}.`);
    }
  }
  if (result.modelResources) {
    const model = validateModelTasksetPackage({ ...result.modelResources, taskset, executionResources: { environment, verifierSet } });
    for (const asset of model.assets) requireAsset(asset.asset);
  } else if (["starter", "rewardBinding", "rewardExecution", "modelTasksetDerivation", "learning"].some(key => taskset.metadata[key] !== undefined)) {
    throw new Error("Bound Taskset publication requires its complete model resources.");
  }
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
