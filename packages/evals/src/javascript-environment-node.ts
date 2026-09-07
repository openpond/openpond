import type { JavaScriptEnvironmentExecutionInput } from "./javascript-environment.js";
import { JavaScriptEnvironmentOperationSchema, JavaScriptEnvironmentResultSchema, type JavaScriptEnvironmentResult } from "./javascript-environment-contract.js";
import { executeJavaScriptIsolateInWorker } from "./javascript-isolate-node.js";
import { executeJavaScriptIsolateInProcess } from "./javascript-isolate-process.js";
import { executeEnvironmentWithServices } from "./environment-execution-services.js";
import { executeSqlInProcess } from "./sql-execution-node.js";

/** The execution owner awaits termination before recording a step or cleanup. */
export async function executeJavaScriptEnvironmentInWorker(input: JavaScriptEnvironmentExecutionInput): Promise<JavaScriptEnvironmentResult> {
  const operation = JavaScriptEnvironmentOperationSchema.parse(input.operation);
  return executeEnvironmentWithServices(input, { sql: executeSqlInProcess, candidate: executeJavaScriptIsolateInProcess, controller: async prepared => JavaScriptEnvironmentResultSchema.parse(await executeJavaScriptIsolateInWorker({ ...prepared, exportName: operation, maxResultBytes: 1_572_864, deterministic: true, errorPrefix: "environment" })) });
}

/** Uses a Node child process independently of the execution owner's runtime. */
export async function executeJavaScriptEnvironmentInProcess(input: JavaScriptEnvironmentExecutionInput): Promise<JavaScriptEnvironmentResult> {
  const operation = JavaScriptEnvironmentOperationSchema.parse(input.operation);
  return executeEnvironmentWithServices(input, { sql: executeSqlInProcess, candidate: executeJavaScriptIsolateInProcess, controller: async prepared => JavaScriptEnvironmentResultSchema.parse(await executeJavaScriptIsolateInProcess({ ...prepared, exportName: operation, maxResultBytes: 1_572_864, deterministic: true, errorPrefix: "environment" })) });
}
