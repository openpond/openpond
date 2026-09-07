import { Worker } from "node:worker_threads";
import { javascriptVerifierWorkerSource } from "./javascript-verifier-worker-source.js";
import { validateJavaScriptIsolateInput, type JavaScriptIsolateInput } from "./javascript-isolate.js";
import { assertBoundedTaskJson } from "./task-schema.js";

/** Both environment steps and graders settle only after their worker stops. */
export async function executeJavaScriptIsolateInWorker(input: JavaScriptIsolateInput): Promise<unknown> {
  input.signal?.throwIfAborted();
  validateJavaScriptIsolateInput(input);
  const signal = input.signal;
  const workerData = { source: input.source, exportName: input.exportName, value: input.value, timeoutMs: input.timeoutMs, maxResultBytes: input.maxResultBytes, deterministic: input.deterministic === true, errorPrefix: input.errorPrefix };
  const error = (suffix: string) => new Error(`${input.errorPrefix}_${suffix}`);
  return new Promise((resolve, reject) => {
    const worker = new Worker(javascriptVerifierWorkerSource, {
      eval: true, workerData, execArgv: [], env: {},
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    let settling = false;
    const finish = (outcome: { result: unknown } | { error: Error }) => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      void worker.terminate().then(() => {
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.result);
      }, reject);
    };
    const cancel = () => finish({ error: signal?.reason instanceof Error ? signal.reason : error("cancelled") });
    const timer = setTimeout(() => finish({ error: error("timeout") }), input.timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    worker.once("error", (error) => finish({ error }));
    worker.once("exit", () => { if (!settling) finish({ error: error("worker_exited_without_result") }); });
    worker.once("message", (message: unknown) => {
      try {
        if (!message || typeof message !== "object" || !("ok" in message)) throw error("worker_invalid_response");
        if (message.ok !== true) throw new Error("error" in message && typeof message.error === "string" ? message.error : `${input.errorPrefix}_execution_failed`);
        if (!("result" in message)) throw error("worker_invalid_response");
        assertBoundedTaskJson(message.result, input.maxResultBytes);
        finish({ result: message.result });
      } catch (cause) { finish({ error: cause instanceof Error ? cause : error("worker_invalid_response") }); }
    });
    if (signal?.aborted) cancel();
  });
}
