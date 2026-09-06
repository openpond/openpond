import { Worker } from "node:worker_threads";
import type { executeJavaScriptVerifier } from "./javascript-verifier.js";
import { JavaScriptVerifierResultSchema, type JavaScriptVerifierResult } from "./javascript-verifier-contract.js";
import { javascriptVerifierWorkerSource } from "./javascript-verifier-worker-source.js";
import { assertBoundedTaskJson } from "./task-schema.js";

/** Resolves/rejects only after the execution owner has stopped the worker. */
export async function executeJavaScriptVerifierInWorker(input: Parameters<typeof executeJavaScriptVerifier>[0]): Promise<JavaScriptVerifierResult> {
  input.signal?.throwIfAborted();
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 300_000) throw new Error("verifier_timeout_invalid");
  assertBoundedTaskJson(input.value, 4_194_304);
  if (new TextEncoder().encode(input.source).byteLength > 524_288) throw new Error("verifier_source_too_large");
  const { signal, ...workerData } = input;
  return new Promise((resolve, reject) => {
    const worker = new Worker(javascriptVerifierWorkerSource, {
      eval: true, workerData, execArgv: [], env: {},
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    let settling = false;
    const finish = (outcome: { result: JavaScriptVerifierResult } | { error: Error }) => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      void worker.terminate().then(() => {
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.result);
      }, reject);
    };
    const cancel = () => finish({ error: signal?.reason instanceof Error ? signal.reason : new Error("verifier_cancelled") });
    const timer = setTimeout(() => finish({ error: new Error("verifier_timeout") }), input.timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    worker.once("error", (error) => finish({ error }));
    worker.once("exit", () => { if (!settling) finish({ error: new Error("verifier_worker_exited_without_result") }); });
    worker.once("message", (message: unknown) => {
      try {
        if (!message || typeof message !== "object" || !("ok" in message)) throw new Error("verifier_worker_invalid_response");
        if (message.ok !== true) throw new Error("error" in message && typeof message.error === "string" ? message.error : "verifier_execution_failed");
        if (!("result" in message)) throw new Error("verifier_worker_invalid_response");
        finish({ result: JavaScriptVerifierResultSchema.parse(message.result) });
      } catch (error) { finish({ error: error instanceof Error ? error : new Error("verifier_worker_invalid_response") }); }
    });
    if (signal?.aborted) cancel();
  });
}
