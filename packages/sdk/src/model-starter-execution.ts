import { z } from "zod";
import { EnvironmentReleaseSchema, VerifierSetReleaseSchema } from "@openpond/evals";
import { JavaScriptEnvironmentDefinitionSchema, assertJavaScriptEnvironmentDefinition } from "@openpond/evals/javascript-environment";
import { createLearningTextAsset, learningRef, sealLearningContent, verifyLearningTextAsset, type LearningTextAsset } from "@openpond/evals/learning";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import type { TasksetRelease } from "@openpond/evals/tasksets";
import { canonicalJson } from "./protocol.js";
import { ModelProjectVersionedRefSchema } from "./model-projects.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ModelStarterEnvironmentAttemptSchema = /* @__PURE__ */ (() => z.object({
  schemaVersion: z.literal("openpond.javascriptEnvironmentAttempt.v1"), taskId: z.string(),
  status: z.enum(["completed", "budget_exhausted", "cancelled", "timed_out", "policy_failure", "environment_failure"]),
  output: z.string().nullable(), collected: z.boolean(), environmentCleanupComplete: z.boolean(),
  snapshot: z.object({ definition: ModelProjectVersionedRefSchema, inputHash: HashSchema, seed: z.number().int(), initialStateHash: HashSchema, finalStateHash: HashSchema, state: z.record(z.string(), z.unknown()), events: z.array(z.record(z.string(), z.unknown())) }).strict().nullable(),
  messages: z.array(z.unknown()), error: z.string().nullable(), contentHash: HashSchema,
}).strict())();

/** Validate an owner-recorded runtime artifact against the admitted task.
 * Provenance/ownership of the artifact remains the execution host's concern. */
export function verifyModelStarterEnvironmentAttempt(value: unknown, context: { taskId: string; input: Record<string, unknown>; seed: number; javascript: z.infer<typeof ModelProjectVersionedRefSchema> }) {
  assertBoundedTaskJson(value, 16_777_216);
  const result = ModelStarterEnvironmentAttemptSchema.parse(value);
  const { contentHash, ...content } = result;
  if (sealLearningContent(content).contentHash !== contentHash || result.taskId !== context.taskId || (result.snapshot && (
    !equal(result.snapshot.definition, context.javascript) || result.snapshot.inputHash !== sealLearningContent(context.input).contentHash || result.snapshot.seed !== context.seed || result.snapshot.finalStateHash !== sealLearningContent(result.snapshot.state).contentHash
  ))) throw new Error("Starter environment attempt differs from its admitted task or recorded bytes.");
  return result;
}

export const ModelStarterExecutionSchema = z.object({
  environment: EnvironmentReleaseSchema,
  verifierSet: VerifierSetReleaseSchema,
  javascript: JavaScriptEnvironmentDefinitionSchema,
}).strict();
export type ModelStarterExecution = z.infer<typeof ModelStarterExecutionSchema>;
export const ModelStarterToolFixtureScriptSchema = z.object({
  actions: z.array(z.object({ name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()) }).strict()).max(1_000),
}).strict();
export type ModelStarterExecutionContext = Pick<TasksetRelease, "environment" | "environmentRelease" | "verifierSetRelease" | "tools" | "capabilities" | "policy" | "graders" | "tasks">;

/** Derivable from immutable Taskset refs, without putting private code in its metadata. */
export function modelStarterExecutionAssetId(context: Pick<ModelStarterExecutionContext, "environmentRelease" | "verifierSetRelease">): string {
  if (!context.environmentRelease || !context.verifierSetRelease) throw new Error("Starter execution release references are missing.");
  return `starter-execution-${sealLearningContent({ environment: context.environmentRelease, verifiers: context.verifierSetRelease }).contentHash}`;
}

/** Persist alongside the package's private assets in the same creation transaction.
 * The existing authored-text resource bound also applies to this small closure. */
export function createModelStarterExecutionAsset(value: ModelStarterExecution): LearningTextAsset {
  const execution = ModelStarterExecutionSchema.parse(value);
  assertExecutionIntegrity(execution);
  const id = modelStarterExecutionAssetId({ environmentRelease: { id: execution.environment.id, contentHash: execution.environment.contentHash }, verifierSetRelease: { id: execution.verifierSet.id, contentHash: execution.verifierSet.contentHash } });
  const generated = createLearningTextAsset({ text: canonicalJson(execution), path: "environment/execution.json", mediaType: "application/json", visibility: "host_private" });
  const { contentHash: _hash, ...content } = generated;
  return sealLearningContent({ ...content, id, asset: { ...content.asset, id } });
}

/** The caller owns and verifies the Taskset manifest; this verifies its private
 * resource graph. Passing selected immutable task rows permits bounded hydration. */
export function resolveModelStarterExecutionAsset(context: ModelStarterExecutionContext, asset: LearningTextAsset, assets: LearningTextAsset[]): ModelStarterExecution {
  if (asset.id !== modelStarterExecutionAssetId(context) || asset.asset.visibility !== "host_private" || asset.asset.mediaType !== "application/json") throw new Error("Starter execution asset differs from its Taskset references.");
  const execution = ModelStarterExecutionSchema.parse(JSON.parse(verifyLearningTextAsset(asset, asset.asset)));
  validateModelStarterExecution(execution, context, assets);
  return execution;
}

function equal(left: unknown, right: unknown): boolean {
  return sealLearningContent({ value: left }).contentHash === sealLearningContent({ value: right }).contentHash;
}

function assertExecutionIntegrity(execution: ModelStarterExecution): void {
  assertJavaScriptEnvironmentDefinition(execution.javascript);
  for (const resource of [execution.environment, execution.verifierSet]) {
    const { contentHash, ...content } = resource;
    if (sealLearningContent(content).contentHash !== contentHash) throw new Error(`Starter execution resource integrity failed: ${resource.id}.`);
  }
  if (!equal(execution.environment.metadata.javascriptEnvironment, learningRef(execution.javascript))) throw new Error("Starter execution resources differ from its declared task context.");
}

/** Close executable dependencies before a host persists or runs a package. */
export function validateModelStarterExecution(
  execution: ModelStarterExecution | undefined,
  taskset: ModelStarterExecutionContext,
  assets: LearningTextAsset[],
): void {
  if (!execution) {
    if (taskset.environment.entrypoint === "openpond.javascript-environment.v1") throw new Error("Starter JavaScript execution resources are missing.");
    return;
  }
  const { environment, verifierSet, javascript } = execution;
  assertExecutionIntegrity(execution);
  if (!equal(taskset.environmentRelease, { id: environment.id, contentHash: environment.contentHash }) ||
      !equal(taskset.verifierSetRelease, { id: verifierSet.id, contentHash: verifierSet.contentHash }) ||
      !equal(environment.contract, taskset.environment) || !equal(verifierSet.graders, taskset.graders) ||
      !equal(taskset.tools, javascript.tools) || !equal(environment.metadata.javascriptEnvironment, learningRef(javascript))) {
    throw new Error("Starter execution resources differ from its declared task context.");
  }
  const contract = environment.contract;
  if (contract.entrypoint !== "openpond.javascript-environment.v1" || contract.kind !== "agent" ||
      !contract.stateful || !contract.deterministicSeeds || contract.networkPolicy !== "none" ||
      new Set(contract.lifecycle).size !== 5 || taskset.capabilities.length || taskset.policy.connectedAppScopes.length) {
    throw new Error("Starter JavaScript environment declares unsupported host capabilities.");
  }
  for (const reference of [javascript.module, environment.actionSchemaRef, environment.observationSchemaRef, environment.stateSchemaRef]) {
    if (!reference) continue;
    const asset = assets.find(asset => asset.id === reference.id);
    if (!asset) throw new Error(`Starter environment asset is missing: ${reference.id}.`);
    verifyLearningTextAsset(asset, reference);
  }
  for (const task of taskset.tasks) {
    const asset = assets.find(asset => asset.id === task.privilegedContextRef);
    if (!asset || asset.asset.visibility !== "host_private" || asset.asset.mediaType !== "application/json") {
      throw new Error(`Starter private initial state is missing: ${task.id}.`);
    }
    const state: unknown = JSON.parse(verifyLearningTextAsset(asset, asset.asset));
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error(`Starter initial state must be a JSON object: ${task.id}.`);
    assertBoundedTaskJson(state, javascript.maxStateBytes);
  }
}
