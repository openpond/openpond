import type { executeJavaScriptVerifier } from "./javascript-verifier.js";
import { assertIsolatedVerifierRuntime, JavaScriptVerifierResultSchema, type JavaScriptVerifierResult } from "./javascript-verifier-contract.js";
import { executeJavaScriptIsolateInWorker } from "./javascript-isolate-node.js";
import { executeJavaScriptIsolateInProcess } from "./javascript-isolate-process.js";

/** Resolves/rejects only after the execution owner has stopped the worker. */
export async function executeJavaScriptVerifierInWorker(input: Parameters<typeof executeJavaScriptVerifier>[0]): Promise<JavaScriptVerifierResult> {
  assertIsolatedVerifierRuntime(input.runtime);
  return JavaScriptVerifierResultSchema.parse(await executeJavaScriptIsolateInWorker({ ...input, exportName: input.exportName ?? "verify", maxResultBytes: 65_536, errorPrefix: "verifier" }));
}

/** Uses a Node child process and waits for exit on success, failure, or cancellation. */
export async function executeJavaScriptVerifierInProcess(input: Parameters<typeof executeJavaScriptVerifier>[0]): Promise<JavaScriptVerifierResult> {
  assertIsolatedVerifierRuntime(input.runtime);
  return JavaScriptVerifierResultSchema.parse(await executeJavaScriptIsolateInProcess({ ...input, exportName: input.exportName ?? "verify", maxResultBytes: 65_536, errorPrefix: "verifier" }));
}
