import type { JavaScriptEnvironmentExecutionInput } from "./javascript-environment.js";
import { JavaScriptEnvironmentOperationSchema, JavaScriptEnvironmentResultSchema, type JavaScriptEnvironmentResult } from "./javascript-environment-contract.js";
import { executeJavaScriptIsolateInWorker } from "./javascript-isolate-node.js";

/** The execution owner awaits termination before recording a step or cleanup. */
export async function executeJavaScriptEnvironmentInWorker(input: JavaScriptEnvironmentExecutionInput): Promise<JavaScriptEnvironmentResult> {
  const operation = JavaScriptEnvironmentOperationSchema.parse(input.operation);
  return JavaScriptEnvironmentResultSchema.parse(await executeJavaScriptIsolateInWorker({ ...input, exportName: operation, maxResultBytes: 1_572_864, deterministic: true, errorPrefix: "environment" }));
}
