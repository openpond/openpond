import { expect, test } from "vitest";

import { contentHash } from "@openpond/harness";
import { createProfileEvaluationComparison } from "../src/profile-evaluation-comparisons.js";
import { TasksetMetricResultSchema } from "../src/metric-policy.js";
import { createTasksetRunManifest, type TasksetRunManifest } from "../src/taskset-run-contract.js";

const harness = { id: "harness-1", contentHash: contentHash("harness-1") };
const taskset = { id: "cases", contentHash: contentHash("frozen-cases") };
const metricPolicy = { schemaVersion: "openpond.tasksetMetricPolicy.v1" as const,
  primaryMetric: "pass_rate", aggregation: "pass_rate" as const,
  missingReward: "exclude" as const, customAggregator: null };
function run(id: string, sourceRevision: string, model: string): TasksetRunManifest {
  return createTasksetRunManifest({
    schemaVersion: "openpond.tasksetRunManifest.v1", id, tasksetRelease: taskset,
    packageHash: contentHash("package"), execution: { kind: "harness", harnessRelease: harness },
    profileEvaluation: { profileId: "personal", sourceRevision, harnessRelease: harness,
      catalogHash: contentHash("catalog"), definitionId: "report-check", definitionHash: contentHash("definition"),
      target: { kind: "workflow", workflowId: "report" }, environmentHash: contentHash("fixed-env") },
    policy: { kind: "model", model: { provider: "test", model, revision: null, artifactHash: null,
      tokenizerRevision: null, chatTemplateHash: null }, configurationHash: contentHash(model) },
    gradingRole: "evaluation", metricPolicy,
    population: [{ receiptId: `receipt-${id}`, taskId: "case-1", seed: "1", fixtureId: null }],
    runtimeTarget: { adapterId: "profile-runner", placement: "local", runtimeVersion: "1", capabilityReceipt: contentHash("runtime") },
    limits: { maxTurns: 10, timeoutMs: 60_000, maxOutputBytes: 1024, maximumSpendUsd: null },
    createdAt: "2026-09-23T00:00:00.000Z", metadata: {},
  });
}
function result(manifest: TasksetRunManifest, score: number) {
  const content = { schemaVersion: "openpond.tasksetMetricResult.v1" as const,
    runManifest: { id: manifest.id, contentHash: manifest.contentHash }, tasksetRelease: taskset,
    policy: metricPolicy, policyHash: contentHash(metricPolicy),
    receiptRefs: [{ id: manifest.population[0]!.receiptId, contentHash: contentHash(manifest.id) }],
    includedCount: 1, missingRewardCount: 0, excludedCount: 0, value: score };
  return TasksetMetricResultSchema.parse({ ...content, contentHash: contentHash(content) });
}

test("Profile comparison pins existing run evidence and rejects changed test conditions", () => {
  const first = run("run-1", "revision-1", "model-a");
  const second = run("run-2", "revision-2", "model-b");
  const comparison = createProfileEvaluationComparison({ id: "comparison-1", createdAt: first.createdAt,
    members: [{ manifest: first, result: result(first, 0.5) }, { manifest: second, result: result(second, 1) }] });
  expect(comparison.members.map((member) => member.score)).toEqual([0.5, 1]);
  expect(comparison.members[1]?.source.sourceRevision).toBe("revision-2");
  const { contentHash: _hash, ...secondContent } = second;
  const changed = createTasksetRunManifest({ ...secondContent, id: "changed-run", population: [{ receiptId: "changed-receipt", taskId: "different-case", seed: "1", fixtureId: null }] });
  expect(() => createProfileEvaluationComparison({ id: "invalid", createdAt: first.createdAt,
    members: [{ manifest: first, result: result(first, 0.5) }, { manifest: changed, result: result(changed, 1) }] }))
    .toThrow("frozen tasks");
});
