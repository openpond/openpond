import { parentPort, workerData } from "node:worker_threads";
import { executeJavaScriptVerifier } from "./javascript-verifier.js";

// Only this trusted host program runs in Node. Authored source is interpreter data.
if (!parentPort) throw new Error("Verifier worker requires its execution owner.");
void executeJavaScriptVerifier(workerData).then(
  (result) => parentPort!.postMessage({ ok: true, result }),
  (error: unknown) => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : "Verifier execution failed." }),
).finally(() => parentPort!.close());
