import { executeJavaScriptIsolateInWorker } from "./javascript-isolate-node.js";
import { executeJavaScriptIsolateInProcess } from "./javascript-isolate-process.js";
import { aggregateTasksetEvaluationReceipts, aggregateTasksetRunReceipts, executeTasksetMetric, type TasksetEvaluationInput, type TasksetRunEvaluationInput, type TasksetMetricExecutionInput, type TasksetMetricExecutor } from "./metrics.js";
import type { TasksetMetricResult } from "./metric-policy.js";
import type { EvaluationResult } from "./runs.js";

/** Verifies original source before stripping TS, then waits for worker termination
 * on success, error or cancellation. Authored imports and host APIs are unavailable. */
export function executeTasksetMetricInWorker(input: TasksetMetricExecutionInput): Promise<TasksetMetricResult> {
  return executeTasksetMetric(input, executeMetric);
}

export function aggregateTasksetEvaluationInWorker(input: TasksetEvaluationInput): Promise<EvaluationResult> {
  return aggregateTasksetEvaluationReceipts(input, executeMetric);
}

export function aggregateTasksetRunInWorker(input: TasksetRunEvaluationInput): Promise<TasksetMetricResult> {
  return aggregateTasksetRunReceipts(input, executeMetric);
}

/** Bun hosts use the same Node process ownership as verifier/environment
 * execution. Type stripping happens in that process within its deadline. */
export function executeTasksetMetricInProcess(input: TasksetMetricExecutionInput): Promise<TasksetMetricResult> {
  return executeTasksetMetric(input, executeProcessMetric);
}

export function aggregateTasksetRunInProcess(input: TasksetRunEvaluationInput): Promise<TasksetMetricResult> {
  return aggregateTasksetRunReceipts(input, executeProcessMetric);
}

const executeMetric: TasksetMetricExecutor = async ({ source, module, exportName, scores, timeoutMs, signal }) => {
  const javascript = /\.[cm]?ts$/.test(module)
    ? (await import("node:module")).stripTypeScriptTypes(source, { mode: "strip" }) : source;
  return executeJavaScriptIsolateInWorker({
      source: javascript,
      exportName, value: scores, timeoutMs, signal,
      maxResultBytes: 1_024, deterministic: true, errorPrefix: "metric",
  });
};

const executeProcessMetric: TasksetMetricExecutor = ({ source, module, exportName, scores, timeoutMs, signal }) =>
  executeJavaScriptIsolateInProcess({ source, exportName, value: scores, timeoutMs, signal, stripTypeScript: /\.[cm]?ts$/.test(module),
    maxResultBytes: 1_024, deterministic: true, errorPrefix: "metric" });
