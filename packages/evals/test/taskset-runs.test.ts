import { expect, test } from "vitest";
import { contentHash } from "@openpond/harness";
import { genericToolConformance } from "../src/conformance.js";
import { createAttemptReceipt, type AttemptReceipt } from "../src/runs.js";
import { aggregateTasksetRunReceipts, assertProfileEvaluationRunAdmission, createTasksetRunManifest, tasksetRunMetricPolicy, TasksetRunManifestSchema, type TasksetRunManifest } from "../src/metrics.js";
import { TasksetReleaseSchema } from "../src/tasksets.js";

const { contentHash: _releaseHash, ...releaseContent } = genericToolConformance.taskset;
const pinnedContent = { ...releaseContent, environmentRelease: { id: "test-environment", contentHash: contentHash("environment") }, verifierSetRelease: { id: "test-verifiers", contentHash: contentHash("verifiers") } };
const taskset = TasksetReleaseSchema.parse({ ...pinnedContent, contentHash: contentHash(pinnedContent) });
const legacy = genericToolConformance.manifest;
const taskId = taskset.tasks[0]!.id;
function manifest(): TasksetRunManifest {
  return createTasksetRunManifest({
    schemaVersion: "openpond.tasksetRunManifest.v1", id: "fixture-run",
    tasksetRelease: { id: taskset.id, contentHash: taskset.contentHash }, packageHash: contentHash("package"),
    execution: { kind: "taskset", environmentRelease: taskset.environmentRelease!, verifierSetRelease: taskset.verifierSetRelease!, policyHash: contentHash(taskset.policy) },
    policy: { kind: "fixture" }, gradingRole: "evaluation", metricPolicy: tasksetRunMetricPolicy(taskset),
    population: ["correct", "wrong", "failed"].map(receiptId => ({ receiptId, taskId, seed: "0", fixtureId: receiptId })),
    runtimeTarget: legacy.runtimeTarget, limits: legacy.limits, createdAt: legacy.createdAt, metadata: {},
  });
}
function receipt(run: TasksetRunManifest, index: number, score: number | null, failureClass: AttemptReceipt["failureClass"] = null): AttemptReceipt {
  const member = run.population[index]!;
  return createAttemptReceipt({
    schemaVersion: "openpond.attemptReceipt.v1", id: member.receiptId, taskId: member.taskId, seed: member.seed,
    runManifest: { id: run.id, contentHash: run.contentHash }, terminal: true, failureClass,
    outputHash: null, traceHash: contentHash(member), artifactRefs: [], graderEvidenceRefs: [],
    startedAt: run.createdAt, completedAt: run.createdAt, latencyMs: 0, costUsd: null,
    metadata: { gradingRole: "evaluation", score, passed: score === 1, rewardEligible: score !== null },
  });
}

// A caller must not improve a run by omitting failures, substituting a different
// seed, or supplying a training-role grade. Existing metrics have no population.
test("complete Taskset runs pin fixture identity, population and evaluation-role evidence", async () => {
  const run = manifest();
  expect(run.policy).toEqual({ kind: "fixture" });
  expect("model" in run.policy).toBe(false);
  const receipts = [receipt(run, 0, 1), receipt(run, 1, 0), receipt(run, 2, null, "infrastructure_failure")];
  const result = await aggregateTasksetRunReceipts({ manifest: run, taskset, receipts: [...receipts].reverse() });
  expect(result.value).toBe(0.5);
  expect(result.includedCount).toBe(2);
  expect(result.excludedCount).toBe(1);
  expect(result.receiptRefs.map(ref => ref.id)).toEqual(run.population.map(member => member.receiptId));
  await expect(aggregateTasksetRunReceipts({ manifest: run, taskset, receipts: receipts.slice(0, 2) })).rejects.toThrow("complete admitted population");
  await expect(aggregateTasksetRunReceipts({ manifest: run, taskset, receipts: [receipts[0]!, receipts[0]!, receipts[2]!] })).rejects.toThrow("complete admitted population");
  const { contentHash: _receiptHash, ...receiptContent } = receipts[0]!;
  for (const replacement of [
    createAttemptReceipt({ ...receiptContent, seed: "other" }),
    createAttemptReceipt({ ...receiptContent, terminal: false }),
    createAttemptReceipt({ ...receiptContent, metadata: { ...receiptContent.metadata, gradingRole: "training" } }),
    { ...receipts[0]!, metadata: { ...receipts[0]!.metadata, score: 0 } },
  ]) await expect(aggregateTasksetRunReceipts({ manifest: run, taskset, receipts: [replacement, ...receipts.slice(1)] })).rejects.toThrow();
  expect(TasksetRunManifestSchema.safeParse({ ...run, policy: { kind: "fixture", model: legacy.model } }).success).toBe(false);
  expect(TasksetRunManifestSchema.safeParse({ ...run, population: [{ ...run.population[0], fixtureId: null }] }).success).toBe(false);
  const { contentHash: _runHash, ...runContent } = run;
  const modelRun = createTasksetRunManifest({ ...runContent, policy: { kind: "model", model: legacy.model, configurationHash: contentHash("config") }, population: run.population.map(member => ({ ...member, fixtureId: null })) });
  expect(modelRun.policy.kind).toBe("model");
  expect(modelRun.contentHash).not.toBe(run.contentHash);
  const changedPolicy = createTasksetRunManifest({ ...runContent, metricPolicy: { ...run.metricPolicy, missingReward: "zero" } });
  await expect(aggregateTasksetRunReceipts({ manifest: changedPolicy, taskset, receipts })).rejects.toThrow("metric differs");
  const changedExecution = createTasksetRunManifest({ ...runContent, execution: { kind: "taskset", environmentRelease: taskset.environmentRelease!, verifierSetRelease: taskset.verifierSetRelease!, policyHash: contentHash("different-policy") } });
  await expect(aggregateTasksetRunReceipts({ manifest: changedExecution, taskset, receipts })).rejects.toThrow("execution differs");
  const profileSource = {
    profileId: "personal", sourceRevision: "abc123",
    harnessRelease: { id: "profile-harness", contentHash: contentHash("profile-harness") },
    catalogHash: contentHash("catalog"), definitionId: "report-check",
    definitionHash: contentHash("definition"), target: { kind: "workflow" as const, workflowId: "report" },
    environmentHash: contentHash("environment"),
  };
  const profileRun = createTasksetRunManifest({
    ...runContent, execution: { kind: "harness", harnessRelease: profileSource.harnessRelease },
    profileEvaluation: profileSource,
  });
  expect(profileRun.profileEvaluation?.sourceRevision).toBe("abc123");
  expect(() => createTasksetRunManifest({
    ...runContent, execution: { kind: "harness", harnessRelease: { id: "other", contentHash: contentHash("other") } },
    profileEvaluation: profileSource,
  })).toThrow("exact bound Harness release");
});

test("Profile admission binds the verifier-only definition to exact frozen cases and seeds", () => {
  const frozen = taskset.tasks.find((task) => task.split === "frozen_eval")!;
  const catalog = {
    schemaVersion: "openpond.profileEvaluations.v1" as const,
    definitions: [{
      id: "report-check", label: "Report", description: "", target: { kind: "workflow" as const, workflowId: "report" },
      tasksetRelease: { id: taskset.id, contentHash: taskset.contentHash }, split: "frozen_eval" as const,
      taskIds: [frozen.id], seeds: ["1", "2"], criterion: { minimumPassRate: 1, requireComplete: true },
    }], suites: [],
  };
  const source = {
    profileId: "personal", sourceRevision: "abc123", harnessRelease: { id: "profile-harness", contentHash: contentHash("profile-harness") },
    catalogHash: contentHash(catalog), definitionId: "report-check", definitionHash: contentHash(catalog.definitions[0]),
    target: catalog.definitions[0]!.target, environmentHash: contentHash("environment"),
  };
  const fixture = manifest();
  const { contentHash: _hash, ...content } = fixture;
  const base = {
    ...content, policy: { kind: "model" as const, model: legacy.model, configurationHash: contentHash("config") },
    execution: { kind: "harness" as const, harnessRelease: source.harnessRelease }, profileEvaluation: source,
    population: ["1", "2"].map((seed, index) => ({ receiptId: `profile-${index}`, taskId: frozen.id, seed, fixtureId: null })),
  };
  const admitted = createTasksetRunManifest(base);
  expect(() => assertProfileEvaluationRunAdmission(admitted, taskset, catalog)).not.toThrow();
  const changedPopulation = createTasksetRunManifest({ ...base, population: base.population.slice(0, 1) });
  expect(() => assertProfileEvaluationRunAdmission(changedPopulation, taskset, catalog)).toThrow("population differs");
  const changedDefinition = { ...catalog, definitions: [{ ...catalog.definitions[0]!, taskIds: [taskset.tasks[0]!.id] }] };
  expect(() => assertProfileEvaluationRunAdmission(admitted, taskset, changedDefinition)).toThrow("catalog differs");
  const wrongSplit = { ...catalog, definitions: [{ ...catalog.definitions[0]!, split: "train" as const, taskIds: [taskset.tasks[0]!.id] }] };
  const wrongSource = { ...source, catalogHash: contentHash(wrongSplit), definitionHash: contentHash(wrongSplit.definitions[0]) };
  const wrongRun = createTasksetRunManifest({ ...base, profileEvaluation: wrongSource, population: [{ ...base.population[0]!, taskId: taskset.tasks[0]!.id }] });
  expect(() => assertProfileEvaluationRunAdmission(wrongRun, taskset, wrongSplit)).toThrow("training cases");
});
