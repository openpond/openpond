import { assertContentHash, contentHash, sha256 } from "@openpond/harness";
import { aggregateEvaluationReceipts, RunManifestSchema, verifyAttemptReceipt, type AttemptReceipt, type EvaluationResult, type RunManifest } from "./runs.js";
import { TasksetMetricPolicySchema, TasksetMetricResultContentSchema, TasksetMetricResultSchema, type TasksetMetricPolicy, type TasksetMetricResult } from "./metric-policy.js";
import { assertTasksetRelease, type TasksetRelease } from "./tasksets.js";
import { TasksetRunManifestSchema, assertTasksetRunRelease, orderTasksetRunReceipts, type TasksetRunManifest } from "./taskset-run-contract.js";
export * from "./metric-policy.js";
export * from "./taskset-run-contract.js";

export interface TasksetMetricExecutionInput {
  manifest: RunManifest | TasksetRunManifest;
  receipts: AttemptReceipt[];
  policy: TasksetMetricPolicy;
  /** Exact UTF-8 module bytes, verified before any compiler or executor sees them. */
  source?: string;
  signal?: AbortSignal;
}

export type TasksetMetricExecutor = (input: {
  source: string;
  module: string;
  exportName: string;
  scores: number[];
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<unknown>;

export interface TasksetEvaluationInput extends Omit<TasksetMetricExecutionInput, "policy"> {
  manifest: RunManifest;
  id: string;
  taskset: TasksetRelease;
  metadata?: Record<string, unknown>;
}

export interface TasksetRunEvaluationInput extends Omit<TasksetMetricExecutionInput, "policy" | "manifest"> {
  manifest: TasksetRunManifest;
  taskset: TasksetRelease;
}

/** Complete Taskset-owned, selected-Harness or fixture runs share the same
 * metric arithmetic, with the population fixed before execution. */
export async function aggregateTasksetRunReceipts(input: TasksetRunEvaluationInput, executor?: TasksetMetricExecutor): Promise<TasksetMetricResult> {
  input.signal?.throwIfAborted();
  assertTasksetRunRelease(input.manifest, input.taskset);
  assertTasksetMetricSource(input.taskset, input.source);
  return executeTasksetMetric({ ...input, policy: input.manifest.metricPolicy, receipts: orderTasksetRunReceipts(input.manifest, input.receipts) }, executor);
}

/** Preflight the exact metric source before any model or tool execution. */
export function assertTasksetMetricSource(taskset: TasksetRelease, source?: string): void {
  assertTasksetRelease(taskset);
  if (taskset.metrics?.customAggregator) assertMetricSource(taskset.metrics.customAggregator, source);
}

/** Bind the declared metric to one frozen release and population, retaining
 * ordinary mean-score accounting independently of the authored calculation. */
export async function aggregateTasksetEvaluationReceipts(input: TasksetEvaluationInput, executor?: TasksetMetricExecutor): Promise<EvaluationResult> {
  assertTasksetMetricSource(input.taskset, input.source);
  if (input.taskset.id !== input.manifest.tasksetRelease.id || input.taskset.contentHash !== input.manifest.tasksetRelease.contentHash) throw new Error("Metric Taskset differs from the Run Manifest's pinned release.");
  const taskIds = new Set(input.taskset.tasks.map(task => task.id));
  if (input.receipts.some(receipt => !taskIds.has(receipt.taskId))) throw new Error("Metric receipt names a task outside the pinned Taskset.");
  const authoredMetric = input.taskset.metrics ? await executeTasksetMetric({ ...input, policy: input.taskset.metrics }, executor) : undefined;
  return aggregateEvaluationReceipts({ id: input.id, manifest: input.manifest, receipts: input.receipts, metadata: input.metadata, authoredMetric });
}

/** Hosts supply the policy from the pinned Taskset, never a mutable form.
 * Operational failures and nonterminal receipts are excluded for every policy.
 * Missing rewards on the remaining receipts obey zero/exclude. A task's weight
 * applies to each of its attempts; pass rate uses the grader's explicit verdict.
 */
export async function executeTasksetMetric(input: TasksetMetricExecutionInput, executor?: TasksetMetricExecutor): Promise<TasksetMetricResult> {
  input.signal?.throwIfAborted();
  const policy = TasksetMetricPolicySchema.parse(input.policy);
  const manifest = input.manifest.schemaVersion === "openpond.tasksetRunManifest.v1"
    ? TasksetRunManifestSchema.parse(input.manifest) : RunManifestSchema.parse(input.manifest);
  assertContentHash(manifest, "Metric Run Manifest");
  if (manifest.schemaVersion === "openpond.tasksetRunManifest.v1") {
    if (contentHash(policy) !== contentHash(manifest.metricPolicy)) throw new Error("Metric policy differs from the admitted run.");
    const ordered = orderTasksetRunReceipts(manifest, input.receipts);
    if (ordered.some((receipt, index) => receipt.id !== input.receipts[index]?.id)) throw new Error("Metric receipts must follow the admitted population order.");
  }
  if (!input.receipts.length || input.receipts.length > 1_000_000) throw new Error("Metric execution requires 1 to 1,000,000 attempt receipts.");
  const ids = new Set<string>();
  const scores: number[] = [];
  const weights: number[] = [];
  let missingRewardCount = 0;
  for (const receipt of input.receipts) {
    input.signal?.throwIfAborted();
    if (!verifyAttemptReceipt(receipt)) throw new Error(`Metric receipt ${receipt.id} has an invalid content hash.`);
    if (receipt.runManifest.id !== manifest.id || receipt.runManifest.contentHash !== manifest.contentHash) throw new Error(`Metric receipt ${receipt.id} belongs to a different Run Manifest.`);
    if (ids.has(receipt.id)) throw new Error(`Metric receipt ${receipt.id} is duplicated.`);
    ids.add(receipt.id);
    if (!receipt.terminal || ["infrastructure_failure", "timeout", "cancelled"].includes(receipt.failureClass ?? "")) continue;
    const score = receipt.metadata.score;
    if (typeof score === "number" && (!Number.isFinite(score) || score < 0 || score > 1)) throw new Error(`Metric receipt ${receipt.id} has an invalid score.`);
    const hasReward = receipt.metadata.rewardEligible === true && typeof score === "number"
      && (policy.aggregation !== "pass_rate" || typeof receipt.metadata.passed === "boolean");
    if (!hasReward) {
      missingRewardCount += 1;
      if (policy.missingReward === "exclude") continue;
    }
    const weight = policy.aggregation === "weighted_mean" && Object.hasOwn(policy.taskWeights!, receipt.taskId) ? policy.taskWeights![receipt.taskId] : undefined;
    if (policy.aggregation === "weighted_mean" && weight === undefined) throw new Error(`Metric policy has no weight for task ${receipt.taskId}.`);
    scores.push(hasReward ? policy.aggregation === "pass_rate" ? Number(receipt.metadata.passed) : score as number : 0);
    weights.push(weight ?? 1);
  }
  let value: number | null = null;
  const receiptRefs = input.receipts.map(({ id, contentHash }) => ({ id, contentHash }));
  const includedCount = scores.length;
  if (policy.customAggregator) {
    assertMetricSource(policy.customAggregator, input.source);
    if (!executor) throw new Error("Custom metrics require an isolated executor.");
    // Empty populations remain unscorable, even if authored code would return a value.
    if (scores.length) {
      const result = await executor({ source: input.source!, module: policy.customAggregator.module, exportName: policy.customAggregator.exportName, scores, timeoutMs: policy.customAggregator.timeoutMs, signal: input.signal });
      if (typeof result !== "number" || !Number.isFinite(result) || result < 0 || result > 1) throw new Error("Custom metric must return a finite number between 0 and 1.");
      value = result;
    }
  } else if (scores.length) {
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    value = scores.reduce((sum, score, index) => sum + score * (weights[index]! / totalWeight), 0);
    value = Math.max(0, Math.min(1, value));
  }
  input.signal?.throwIfAborted();
  const content = TasksetMetricResultContentSchema.parse({
    schemaVersion: "openpond.tasksetMetricResult.v1",
    runManifest: { id: manifest.id, contentHash: manifest.contentHash },
    tasksetRelease: manifest.tasksetRelease,
    policy,
    policyHash: contentHash(policy),
    receiptRefs,
    includedCount,
    missingRewardCount,
    excludedCount: receiptRefs.length - includedCount,
    value,
  });
  return TasksetMetricResultSchema.parse({ ...content, contentHash: contentHash(content) });
}

function assertMetricSource(aggregator: NonNullable<TasksetMetricPolicy["customAggregator"]>, source?: string): void {
  if (source === undefined || new TextEncoder().encode(source).byteLength > 524_288 || sha256(source) !== aggregator.contentHash) throw new Error("Metric module bytes do not match the pinned content hash or exceed the source limit.");
}
