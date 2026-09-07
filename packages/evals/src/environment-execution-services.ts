import type { JavaScriptEnvironmentExecutionInput } from "./javascript-environment.js";
import type { JavaScriptEnvironmentResult } from "./javascript-environment-contract.js";
import { EnvironmentExecutionServiceSchema, type EnvironmentValueReference } from "./environment-execution-services-contract.js";
import { JavaScriptIsolateExecutionError, type JavaScriptIsolateInput } from "./javascript-isolate.js";
import { assertBoundedTaskJson } from "./task-schema.js";
import { assertSqlExecutionRequest, type SqlExecutionRequest, type SqlExecutionResult } from "./sql-execution-contract.js";

type Runners = {
  controller: (input: JavaScriptEnvironmentExecutionInput) => Promise<JavaScriptEnvironmentResult>;
  candidate: (input: JavaScriptIsolateInput) => Promise<unknown>;
  sql?: (input: { request: SqlExecutionRequest; timeoutMs: number; signal?: AbortSignal }) => Promise<SqlExecutionResult>;
};
function resolveValue(value: Record<string, unknown>, reference: EnvironmentValueReference): unknown {
  let resolved = reference.scope === "arguments" ? (value.action as { arguments?: unknown } | null)?.arguments : value[reference.scope];
  for (const key of reference.path) {
    if (!resolved || typeof resolved !== "object" || !Object.hasOwn(resolved, key)) throw new Error("environment_service_reference_missing");
    resolved = (resolved as Record<string, unknown>)[key];
  }
  return resolved;
}

/** The single returned promise owns service work, controller execution and cancellation. */
export async function executeEnvironmentWithServices(input: JavaScriptEnvironmentExecutionInput, runners: Runners): Promise<JavaScriptEnvironmentResult> {
  if (!input.executionServices?.length) return runners.controller(input);
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000) throw new Error("environment_timeout_invalid");
  assertBoundedTaskJson(input.value, 4_194_304);
  const services = input.executionServices.map(service => EnvironmentExecutionServiceSchema.parse(service));
  if (services.length > 16) throw new Error("environment_service_limit");
  if (new Set(services.map(service => service.id)).size !== services.length) throw new Error("environment_service_identity_collision");
  const started = Date.now();
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error("environment_timeout")), input.timeoutMs);
  try {
    const results: Record<string, unknown> = Object.create(null);
    for (const service of services) {
      signal.throwIfAborted();
      if (service.operation !== input.operation || (service.operation === "step" && service.toolName !== (input.value.action as { name?: unknown } | null)?.name)) throw new Error("environment_service_operation_mismatch");
      const budget = Math.min(service.timeoutMs, input.timeoutMs - (Date.now() - started));
      if (budget < 1) throw new Error("environment_timeout");
      const deadline = new AbortController();
      const serviceSignal = AbortSignal.any([signal, deadline.signal]);
      const serviceTimer = setTimeout(() => deadline.abort(new Error("environment_service_timeout")), budget);
      const serviceStarted = Date.now();
      try {
        if (service.kind === "sqlite.v1") {
          if (!runners.sql) throw new Error("environment_sql_executor_required");
          const sql = resolveValue(input.value, service.sql);
          if (typeof sql !== "string" || !sql.length || new TextEncoder().encode(sql).byteLength > 65_536 || sql.includes("\0")) { results[service.id] = { status: "rejected", code: "invalid_submission" }; continue; }
          const request = assertSqlExecutionRequest({ schemaVersion: "openpond.sqlExecution.v1", snapshot: resolveValue(input.value, service.snapshot), sql, maxRows: service.maxRows, maxResultBytes: service.maxResultBytes });
          results[service.id] = await runners.sql({ request, timeoutMs: input.timeoutMs, signal: serviceSignal });
        } else {
          const source = resolveValue(input.value, service.source), cases = resolveValue(input.value, service.cases);
          if (typeof source !== "string" || new TextEncoder().encode(source).byteLength > 524_288) { results[service.id] = { status: "rejected", code: "invalid_submission" }; continue; }
          if (!Array.isArray(cases) || !cases.length || cases.length > service.maxCases || cases.some(item => !item || typeof item !== "object" || !Object.hasOwn(item, "input"))) throw new Error("environment_service_cases_invalid");
          const values: unknown[] = [];
          for (const item of cases) {
            const remaining = budget - (Date.now() - serviceStarted);
            if (remaining < 1) { deadline.abort(new Error("environment_service_timeout")); serviceSignal.throwIfAborted(); }
            // Hidden expected results and all other case fields remain with the owner.
            values.push(await runners.candidate({ source, exportName: service.exportName, value: structuredClone(item.input), timeoutMs: Math.max(1, remaining), maxResultBytes: service.maxResultBytes, deterministic: true, errorPrefix: "candidate", signal: serviceSignal }));
            if (new TextEncoder().encode(JSON.stringify({ status: "completed", cases: values })).byteLength > service.maxResultBytes) throw new JavaScriptIsolateExecutionError("candidate_result_too_large");
          }
          results[service.id] = { status: "completed", cases: values };
        }
      } catch (error) {
        signal.throwIfAborted();
        if (deadline.signal.aborted) results[service.id] = { status: "rejected", code: "timeout" };
        else if (error instanceof JavaScriptIsolateExecutionError) results[service.id] = { status: "rejected", code: "execution_failed" };
        else throw error;
      } finally { clearTimeout(serviceTimer); }
    }
    signal.throwIfAborted();
    const remaining = input.timeoutMs - (Date.now() - started);
    if (remaining < 1) throw new Error("environment_timeout");
    return await runners.controller({ ...input, executionServices: undefined, value: { ...input.value, services: results }, timeoutMs: remaining, signal });
  } finally { clearTimeout(timer); }
}
