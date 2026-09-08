import type { Taskset } from "@openpond/contracts";
import { assertTasksetMetricResult, type EvaluationResult } from "@openpond/evals";
import { contentHash } from "@openpond/harness";

/** Read the primary score only after verifying its exact evaluation population. */
export function tasksetEvaluationScore(taskset: Taskset, evaluation: EvaluationResult): number | null {
  if (!taskset.metrics) return evaluation.meanScore;
  const metric = evaluation.authoredMetric;
  if (!metric) throw new Error("Baseline Evaluation lacks the Taskset's authored primary metric.");
  assertTasksetMetricResult(metric);
  if (metric.policyHash !== contentHash(taskset.metrics)
    || contentHash(metric.runManifest) !== contentHash(evaluation.runManifest)
    || contentHash(metric.tasksetRelease) !== contentHash(evaluation.tasksetRelease)
    || contentHash(metric.receiptRefs) !== contentHash(evaluation.receiptRefs)) {
    throw new Error("Baseline authored metric does not match the Taskset policy and Evaluation population.");
  }
  return metric.value;
}
