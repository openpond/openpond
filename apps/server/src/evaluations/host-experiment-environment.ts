import { createHash } from "node:crypto";
import { contentHash } from "@openpond/harness";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import {
  JavaScriptEnvironmentResultSchema,
  type JavaScriptEnvironmentExecutionInput,
} from "@openpond/evals/javascript-environment";
import { verifyLearningTextAsset } from "@openpond/evals/learning";
import { HOST_STORAGE_CONTRACT_VERSION, type AgentHostStorageClient } from "@openpond/agent-runtime";
import type { ExperimentModelCase } from "./experiment-case-contract.js";

/** Prepared compute belongs to the execution host. This adapter forwards only
 * Evals lifecycle values; private module bytes are resolved from admitted pins. */
export function createHostExperimentEnvironment(client: AgentHostStorageClient, request: ExperimentModelCase) {
  if (request.environment.kind !== "javascript") throw new Error("experiment_environment_required");
  const { definition, asset } = request.environment;
  const source = verifyLearningTextAsset(asset, definition.module);
  const identity = createHash("sha256").update(request.id).digest("hex");
  let ordinal = 0;
  return async (input: JavaScriptEnvironmentExecutionInput) => {
    input.signal?.throwIfAborted();
    if (input.source !== source) throw new Error("experiment_environment_source_mismatch");
    const action = input.value.action as { name?: unknown } | null;
    const services = definition.executionServices?.filter(service => service.operation === input.operation
      && (input.operation !== "step" || service.toolName === action?.name)) ?? [];
    if (contentHash(input.executionServices ?? []) !== contentHash(services)) {
      throw new Error("experiment_environment_services_mismatch");
    }
    const call = ordinal++;
    const result = await client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: `environment-${identity}-${call}`,
      operation: "experiment/environment",
      params: { caseId: request.id, admissionHash: request.admissionHash,
        definitionHash: definition.contentHash, ordinal: call,
        operation: input.operation, value: input.value, timeoutMs: input.timeoutMs },
    }, 300_000);
    input.signal?.throwIfAborted();
    assertBoundedTaskJson(result, 1_572_864);
    return JavaScriptEnvironmentResultSchema.parse(result);
  };
}
