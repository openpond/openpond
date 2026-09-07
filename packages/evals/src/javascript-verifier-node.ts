import type { executeJavaScriptVerifier } from "./javascript-verifier.js";
import { JavaScriptVerifierResultSchema, type JavaScriptVerifierResult } from "./javascript-verifier-contract.js";
import { executeJavaScriptIsolateInWorker } from "./javascript-isolate-node.js";

/** Resolves/rejects only after the execution owner has stopped the worker. */
export async function executeJavaScriptVerifierInWorker(input: Parameters<typeof executeJavaScriptVerifier>[0]): Promise<JavaScriptVerifierResult> {
  return JavaScriptVerifierResultSchema.parse(await executeJavaScriptIsolateInWorker({ ...input, exportName: input.exportName ?? "verify", maxResultBytes: 65_536, errorPrefix: "verifier" }));
}
