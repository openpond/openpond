import { executeJavaScriptIsolate } from "./javascript-isolate.js";
import { assertIsolatedVerifierRuntime, JavaScriptVerifierResultSchema, type JavaScriptVerifierResult } from "./javascript-verifier-contract.js";
export { JavaScriptVerifierResultSchema, type JavaScriptVerifierResult } from "./javascript-verifier-contract.js";

/** A fresh interpreter with no filesystem, network, timers or module loader.
 * Hosts should use the worker entrypoint for cancellation and responsiveness. */
export async function executeJavaScriptVerifier(input: {
  source: string;
  exportName?: string;
  value: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  runtime?: "isolated_javascript" | "sandbox_process";
}): Promise<JavaScriptVerifierResult> {
  assertIsolatedVerifierRuntime(input.runtime);
  const result = await executeJavaScriptIsolate({ ...input, exportName: input.exportName ?? "verify", maxResultBytes: 65_536, errorPrefix: "verifier" });
  return JavaScriptVerifierResultSchema.parse(result);
}
