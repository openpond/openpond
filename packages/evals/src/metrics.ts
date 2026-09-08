import { assertContentHash, contentHash, sha256 } from "@openpond/harness";
import { RunManifestSchema, verifyAttemptReceipt, type AttemptReceipt, type RunManifest } from "./runs.js";
import { TasksetMetricPolicySchema, TasksetMetricResultContentSchema, TasksetMetricResultSchema, type TasksetMetricPolicy, type TasksetMetricResult } from "./metric-policy.js";
export * from "./metric-policy.js";

export interface TasksetMetricExecutionInput {
  manifest: RunManifest;
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

/** Hosts supply the policy from the pinned Taskset, never a mutable form.
 * Operational failures and nonterminal receipts are excluded for every policy.
 * Missing rewards on the remaining receipts obey zero/exclude. A task's weight
 * applies to each of its attempts; pass rate uses the grader's explicit verdict.
 */
export async function executeTasksetMetric(input: TasksetMetricExecutionInput, executor?: TasksetMetricExecutor): Promise<TasksetMetricResult> {
  input.signal?.throwIfAborted();
  const policy = TasksetMetricPolicySchema.parse(input.policy);
  const manifest = RunManifestSchema.parse(input.manifest);
  assertContentHash(manifest, "Metric Run Manifest");
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
    if (input.source === undefined || new TextEncoder().encode(input.source).byteLength > 524_288 || sha256(input.source) !== policy.customAggregator.contentHash) throw new Error("Metric module bytes do not match the pinned content hash or exceed the source limit.");
    if (!executor) throw new Error("Custom metrics require an isolated executor.");
    // Empty populations remain unscorable, even if authored code would return a value.
    if (scores.length) {
      const result = await executor({ source: input.source, module: policy.customAggregator.module, exportName: policy.customAggregator.exportName, scores, timeoutMs: policy.customAggregator.timeoutMs, signal: input.signal });
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
