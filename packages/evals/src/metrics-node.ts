import { stripTypeScriptTypes } from "node:module";
import { executeJavaScriptIsolateInWorker } from "./javascript-isolate-node.js";
import { executeTasksetMetric, type TasksetMetricExecutionInput } from "./metrics.js";
import type { TasksetMetricResult } from "./metric-policy.js";

/** Verifies original source before stripping TS, then waits for worker termination
 * on success, error or cancellation. Authored imports and host APIs are unavailable. */
export function executeTasksetMetricInWorker(input: TasksetMetricExecutionInput): Promise<TasksetMetricResult> {
  return executeTasksetMetric(input, ({ source, module, exportName, scores, timeoutMs, signal }) =>
    executeJavaScriptIsolateInWorker({
      source: /\.[cm]?ts$/.test(module) ? stripTypeScriptTypes(source, { mode: "strip" }) : source,
      exportName, value: scores, timeoutMs, signal,
      maxResultBytes: 1_024, deterministic: true, errorPrefix: "metric",
    }));
}
