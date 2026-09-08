import { expect, test } from "vitest";
import { assertContentHash, contentHash, sha256 } from "@openpond/harness";
import { genericToolConformance } from "../src/conformance.js";
import { createAttemptReceipt, type AttemptReceipt } from "../src/runs.js";
import { executeTasksetMetric, TasksetMetricPolicySchema, type TasksetMetricPolicy } from "../src/metrics.js";
import { executeJavaScriptIsolate } from "../src/javascript-isolate.js";

const manifest = genericToolConformance.manifest;
const policy: TasksetMetricPolicy = { schemaVersion: "openpond.tasksetMetricPolicy.v1", primaryMetric: "quality", aggregation: "mean_score", missingReward: "zero", customAggregator: null };
function receipt(id: string, metadata: Record<string, unknown>, failureClass: AttemptReceipt["failureClass"] = null, terminal = true) {
  return createAttemptReceipt({
    schemaVersion: "openpond.attemptReceipt.v1", id, taskId: id,
    runManifest: { id: manifest.id, contentHash: manifest.contentHash },
    seed: "0", terminal, failureClass, outputHash: null, traceHash: contentHash(id),
    artifactRefs: [], graderEvidenceRefs: [], startedAt: manifest.createdAt, completedAt: manifest.createdAt,
    latencyMs: 0, costUsd: null, metadata,
  });
}

// Metric choices must change the value without turning operational failures into
// policy scores or silently inventing weights or grader pass verdicts.
test("applies authored weighting, explicit pass verdicts and missing-reward denominators", async () => {
  const receipts = [receipt("a", { score: 0.8, passed: true, rewardEligible: true }), receipt("b", { score: 0.4, passed: false, rewardEligible: true }), receipt("missing", {}), receipt("infra", { score: 1, passed: true, rewardEligible: true }, "infrastructure_failure"), receipt("pending", { score: 1, rewardEligible: true }, null, false)];
  const mean = await executeTasksetMetric({ manifest, receipts, policy });
  expect(mean).toMatchObject({ value: expect.closeTo(0.4), includedCount: 3, missingRewardCount: 1, excludedCount: 2 });
  expect(mean.receiptRefs).toHaveLength(5);
  expect(mean.policyHash).toBe(contentHash(policy));
  assertContentHash(mean, "Metric result");
  expect((await executeTasksetMetric({ manifest, receipts, policy: { ...policy, missingReward: "exclude" } })).value).toBeCloseTo(0.6);
  expect((await executeTasksetMetric({ manifest, receipts, policy: { ...policy, aggregation: "pass_rate" } })).value).toBeCloseTo(1 / 3);
  expect((await executeTasksetMetric({ manifest, receipts, policy: { ...policy, aggregation: "weighted_mean", taskWeights: { a: 3, b: 1, missing: 2 } } })).value).toBeCloseTo(2.8 / 6);
  await expect(executeTasksetMetric({ manifest, receipts, policy: { ...policy, aggregation: "weighted_mean", taskWeights: { a: 3 } } })).rejects.toThrow("no weight");
  expect(TasksetMetricPolicySchema.safeParse({ ...policy, aggregation: "weighted_mean" }).success).toBe(false);
  expect(TasksetMetricPolicySchema.safeParse({ ...policy, taskWeights: { a: 1 } }).success).toBe(false);
  const noVerdict = [receipt("a", { score: 1, rewardEligible: true })];
  expect((await executeTasksetMetric({ manifest, receipts: noVerdict, policy: { ...policy, aggregation: "pass_rate", missingReward: "exclude" } })).value).toBeNull();
});

// Immutable evidence must not allow duplicate weighting, cross-run injection,
// tampered scores or an edited module to inherit a previously pinned hash.
test("rejects invalid evidence and verifies module bytes before dispatch", async () => {
  const a = receipt("a", { score: 1, passed: true, rewardEligible: true });
  await expect(executeTasksetMetric({ manifest, receipts: [a, a], policy })).rejects.toThrow("duplicated");
  await expect(executeTasksetMetric({ manifest, receipts: [{ ...a, metadata: { score: 0 } }], policy })).rejects.toThrow("invalid content hash");
  await expect(executeTasksetMetric({ manifest: { ...manifest, id: "changed" }, receipts: [a], policy })).rejects.toThrow();
  const { contentHash: _, ...differentRun } = a;
  await expect(executeTasksetMetric({ manifest, receipts: [createAttemptReceipt({ ...differentRun, runManifest: { ...a.runManifest, id: "other-run" } })], policy })).rejects.toThrow("different Run Manifest");
  await expect(executeTasksetMetric({ manifest, receipts: [receipt("bad", { score: 2, rewardEligible: true })], policy })).rejects.toThrow("invalid score");
  let dispatched = false;
  const custom: TasksetMetricPolicy = { ...policy, aggregation: "custom", customAggregator: { module: "metric.js", exportName: "aggregate", contentHash: sha256("original"), timeoutMs: 1_000, networkPolicy: "none" } };
  await expect(executeTasksetMetric({ manifest, receipts: [a], policy: custom, source: "edited" }, async () => { dispatched = true; return 1; })).rejects.toThrow("pinned content hash");
  expect(dispatched).toBe(false);
});

// Authored aggregation is untrusted code, including loops, imports, random
// numbers and nonnumeric outputs. None may produce a plausible metric value.
test("executes bounded deterministic custom metrics and preserves empty populations", async () => {
  const receipts = [receipt("a", { score: 0.8, rewardEligible: true }), receipt("b", { score: 0.4, rewardEligible: true })];
  const run = (source: string, timeoutMs = 1_000, attempts = receipts) => executeTasksetMetric({ manifest, receipts: attempts, source, policy: { ...policy, aggregation: "custom", customAggregator: { module: "metric.js", exportName: "aggregate", contentHash: sha256(source), timeoutMs, networkPolicy: "none" } } }, ({ source, exportName, scores, timeoutMs, signal }) => executeJavaScriptIsolate({ source, exportName, value: scores, timeoutMs, signal, maxResultBytes: 1_024, deterministic: true, errorPrefix: "metric" }));
  expect((await run("export async function aggregate(scores) { await Promise.resolve(); return Math.min(...scores); }")).value).toBe(0.4);
  expect((await run("export function aggregate() { return ['process', 'require', 'fetch', 'WebSocket'].every(key => !(key in globalThis)) ? 1 : 0; }")).value).toBe(1);
  await expect(run("import fs from 'node:fs'; export function aggregate() { return 1; }")).rejects.toThrow();
  await expect(run("export function aggregate() { return Math.random(); }")).rejects.toThrow();
  await expect(run("export function aggregate() { for (;;) {} }", 40)).rejects.toThrow();
  await expect(run("export function aggregate() { return NaN; }")).rejects.toThrow("finite number");
  await expect(run("export function aggregate() { return 2; }")).rejects.toThrow("finite number");
  expect((await run("export function aggregate() { throw Error('must not run'); }", 1_000, [receipt("infra", {}, "infrastructure_failure")])).value).toBeNull();
});
