import { contentHash } from "@openpond/harness";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { verifyLearningTextAsset } from "@openpond/evals/learning";
import { executeJavaScriptEnvironmentInProcess } from "@openpond/evals/javascript-environment/node";
import { resolveTasksetPackageExecution, type TasksetPackage } from "openpond-sdk/taskset-packages";
import type { ExperimentModelCase } from "./experiment-case-contract.js";
import { LocalExperimentError } from "./local-experiment-contract.js";

type Runner = typeof executeJavaScriptEnvironmentInProcess;
export type LocalEnvironmentOwner = {
  preflight(value: TasksetPackage): Promise<void>;
  resolve(request: ExperimentModelCase, record: (value: Record<string, unknown>) => Promise<void>): Runner;
};

/** Local means the declared Evals services run on this computer. Authored code
 * stays QuickJS data; SQL receives a read-only in-memory snapshot. The existing
 * process runners bound memory/time and settle only after their children exit.
 * No hosted sandbox, filesystem, network or unrelated tools are substituted. */
export function createLocalExperimentEnvironment(): LocalEnvironmentOwner {
  let readiness: Promise<void> | undefined;
  async function checkRuntime() {
    const source = "export function collect(v) { return {state:v.state,observation:{ready:v.services.js.cases[0]===7&&v.services.sql.status==='completed'}}; }";
    const result = await executeJavaScriptEnvironmentInProcess({
      source, operation: "collect", timeoutMs: 10_000,
      value: { input: { sql: "SELECT 1" }, state: {}, initialState: { source: "export function check(v){return v;}", cases: [{ input: 7 }], snapshot: { tables: [] } }, action: null },
      executionServices: [
        { id: "js", kind: "javascript.v1", operation: "collect", timeoutMs: 4_000,
          source: { scope: "initialState", path: ["source"] }, cases: { scope: "initialState", path: ["cases"] },
          exportName: "check", maxCases: 1, maxResultBytes: 256 },
        { id: "sql", kind: "sqlite.v1", operation: "collect", timeoutMs: 4_000,
          sql: { scope: "input", path: ["sql"] }, snapshot: { scope: "initialState", path: ["snapshot"] },
          maxRows: 1, maxResultBytes: 256 },
      ],
    });
    if (result.observation.ready !== true) throw new Error("local_environment_runtime_unavailable");
  }
  return {
    async preflight(value) {
      const execution = resolveTasksetPackageExecution(value);
      if (!execution) return;
      const definition = execution.execution.javascript;
      const asset = execution.assets.find(asset => asset.id === definition.module.id);
      if (!asset) throw new LocalExperimentError("local_environment_assets_missing", "The exact environment module is unavailable.", 422);
      verifyLearningTextAsset(asset, definition.module);
      // The strict Evals package/definition schema admits only these services.
      // Import/dependency/file/network capabilities require a different owner.
      if (definition.executionServices?.some(service => service.kind !== "javascript.v1" && service.kind !== "sqlite.v1"))
        throw new LocalExperimentError("local_environment_service_unavailable", "This Dataset requires an unsupported local execution service.", 422);
      readiness ??= checkRuntime().catch(error => { readiness = undefined; throw error; });
      try { await readiness; }
      catch { throw new LocalExperimentError("local_environment_runtime_unavailable", "The local isolated JavaScript/SQL runtime is unavailable.", 503); }
    },
    resolve(request, record) {
      if (request.environment.kind !== "javascript") throw new Error("local_environment_required");
      const environment = request.environment;
      const { definition, asset } = environment;
      const source = verifyLearningTextAsset(asset, definition.module);
      let ordinal = 0;
      let stateHash = contentHash({});
      let active = false;
      return async input => {
        input.signal?.throwIfAborted();
        if (active) throw new Error("local_environment_operation_in_progress");
        if (input.source !== source) throw new Error("local_environment_source_mismatch");
        if (contentHash(input.value.initialState) !== contentHash(environment.initialState)
          || contentHash(input.value.input) !== contentHash(request.input)
          || input.value.seed !== environment.seed || contentHash(input.value.state) !== stateHash)
          throw new Error("local_environment_private_state_mismatch");
        const action = input.value.action as { name?: unknown } | null;
        const services = definition.executionServices?.filter(service => service.operation === input.operation && (input.operation !== "step" || service.toolName === action?.name)) ?? [];
        if (contentHash(input.executionServices ?? []) !== contentHash(services)) throw new Error("local_environment_service_mismatch");
        assertBoundedTaskJson(input.value, 4_194_304);
        const identity = { ordinal: ordinal++, operation: input.operation, definitionHash: definition.contentHash,
          servicesHash: contentHash(services), requestHash: contentHash(input.value), runtime: "desktop-local-evals-process" };
        await record({ ...identity, status: "admitted" });
        active = true;
        try {
          const result = await executeJavaScriptEnvironmentInProcess(input);
          stateHash = contentHash(result.state);
          // Only hashes leave this private execution boundary. Raw state and
          // hidden service cases remain with the evaluator for grading.
          await record({ ...identity, status: "completed", resultHash: contentHash(result), childCleanupComplete: true });
          return result;
        } catch (error) {
          await record({ ...identity, status: input.signal?.aborted ? "cancelled" : "failed", childCleanupComplete: true });
          throw error;
        } finally { active = false; }
      };
    },
  };
}
