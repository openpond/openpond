import { z } from "zod";
import { EnvironmentReleaseSchema, VerifierSetReleaseSchema } from "@openpond/evals";
import { JavaScriptEnvironmentDefinitionSchema, assertJavaScriptEnvironmentDefinition } from "@openpond/evals/javascript-environment";
import { learningRef, sealLearningContent, verifyLearningTextAsset, type LearningTextAsset } from "@openpond/evals/learning";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import type { TasksetRelease } from "@openpond/evals/tasksets";

export const ModelStarterExecutionSchema = z.object({
  environment: EnvironmentReleaseSchema,
  verifierSet: VerifierSetReleaseSchema,
  javascript: JavaScriptEnvironmentDefinitionSchema,
}).strict();
export type ModelStarterExecution = z.infer<typeof ModelStarterExecutionSchema>;

function equal(left: unknown, right: unknown): boolean {
  return sealLearningContent({ value: left }).contentHash === sealLearningContent({ value: right }).contentHash;
}

/** Close executable dependencies before a host persists or runs a package. */
export function validateModelStarterExecution(
  execution: ModelStarterExecution | undefined,
  taskset: TasksetRelease,
  assets: LearningTextAsset[],
): void {
  if (!execution) {
    if (taskset.environment.entrypoint === "openpond.javascript-environment.v1") throw new Error("Starter JavaScript execution resources are missing.");
    return;
  }
  const { environment, verifierSet, javascript } = execution;
  assertJavaScriptEnvironmentDefinition(javascript);
  for (const resource of [environment, verifierSet]) {
    const { contentHash, ...content } = resource;
    if (sealLearningContent(content).contentHash !== contentHash) throw new Error(`Starter execution resource integrity failed: ${resource.id}.`);
  }
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
