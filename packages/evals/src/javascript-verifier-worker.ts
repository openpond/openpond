import { parentPort, workerData } from "node:worker_threads";
import { executeJavaScriptIsolate } from "./javascript-isolate.js";

// Only this trusted host program runs in Node. Authored source is interpreter data.
if (!parentPort) throw new Error("JavaScript worker requires its execution owner.");
void executeJavaScriptIsolate(workerData).then(
  (result) => parentPort!.postMessage({ ok: true, result }),
  (error: unknown) => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : "JavaScript execution failed." }),
).finally(() => parentPort!.close());
