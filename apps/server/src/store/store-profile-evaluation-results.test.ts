import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";
import { contentHash } from "@openpond/harness";
import {
  createProfileEvaluationComparison, createTasksetRunManifest,
  executeProfileEvaluationRun, tasksetRunMetricPolicy,
} from "@openpond/evals";
import { genericToolConformance } from "@openpond/evals/conformance";

import { SqliteStore } from "./store.js";

const taskset = genericToolConformance.taskset;
const frozen = taskset.tasks.find((task) => task.split === "frozen_eval")!;
const harnessRelease = { id: genericToolConformance.harness.id, contentHash: genericToolConformance.harness.contentHash };
const definition = {
  id: "workflow-check", label: "Workflow check", description: "",
  target: { kind: "workflow" as const, workflowId: "report" },
  tasksetRelease: { id: taskset.id, contentHash: taskset.contentHash },
  split: "frozen_eval" as const, taskIds: [frozen.id], seeds: ["7"],
  criterion: { minimumPassRate: 1, requireComplete: true },
};
const catalog = { schemaVersion: "openpond.profileEvaluations.v1" as const, definitions: [definition], suites: [] };
const source = {
  profileId: "team-profile", sourceRevision: "commit-1", harnessRelease,
  catalogHash: contentHash(catalog), definitionId: definition.id, definitionHash: contentHash(definition),
  target: definition.target, environmentHash: contentHash("controlled-data"),
};
const profileRef = { source: "openpond_git" as const, repositoryId: "team-profile-repo", profileId: source.profileId };

function manifest(id: string, receiptId: string) {
  return createTasksetRunManifest({
    schemaVersion: "openpond.tasksetRunManifest.v1", id,
    tasksetRelease: definition.tasksetRelease, packageHash: contentHash("taskset-package"),
    execution: { kind: "harness", harnessRelease }, profileEvaluation: source,
    policy: { kind: "model", model: genericToolConformance.manifest.model, configurationHash: contentHash("model-config") },
    gradingRole: "evaluation", metricPolicy: tasksetRunMetricPolicy(taskset),
    population: [{ receiptId, taskId: frozen.id, seed: "7", fixtureId: null }],
    runtimeTarget: genericToolConformance.manifest.runtimeTarget,
    limits: genericToolConformance.manifest.limits,
    createdAt: genericToolConformance.manifest.createdAt, metadata: {},
  });
}

test("Profile evaluation grades, receipts, runs and comparison survive restart with exact membership", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-profile-evaluation-"));
  let store = new SqliteStore(directory);
  try {
    const members = [];
    for (const ordinal of [1, 2]) {
      const runManifest = manifest(`profile-run-${ordinal}`, `profile-attempt-${ordinal}`);
      const result = await executeProfileEvaluationRun({
        manifest: runManifest, taskset, catalog,
        execute: async () => ({
          evidence: { output: { text: "done" }, runtimeEventRefs: [], artifactRefs: [] },
          traceHash: contentHash(`trace-${ordinal}`), artifactRefs: [],
          startedAt: runManifest.createdAt, completedAt: runManifest.createdAt,
          latencyMs: 0, costUsd: null, terminal: true,
        }),
        saveGrade: async (grade) => {
          await store.saveProfileEvaluationGrade(grade);
          return { id: grade.contentHash, contentHash: grade.contentHash, mediaType: "application/json", sizeBytes: null };
        },
        saveReceipt: (receipt) => store.saveProfileEvaluationReceipt(receipt).then(() => undefined),
      });
      const content = {
        profileRef,
        manifest: runManifest, metric: result.metric,
        gradeRefs: result.grades.map((grade) => ({ id: grade.contentHash, contentHash: grade.contentHash })),
        receiptRefs: result.receipts.map((receipt) => ({ id: receipt.id, contentHash: receipt.contentHash })),
        passRate: result.passRate, passed: result.passed, completedAt: runManifest.createdAt,
      };
      const saved = await store.saveProfileEvaluationRun({ ...content, contentHash: contentHash(content) });
      expect(saved.manifest.id).toBe(runManifest.id);
      members.push({ manifest: runManifest, result: result.metric });
    }
    const comparison = createProfileEvaluationComparison({
      id: "profile-comparison", members, createdAt: genericToolConformance.manifest.createdAt,
    });
    await store.saveProfileEvaluationComparison(profileRef, comparison);
    await store.close();
    store = new SqliteStore(directory);
    expect(await store.listProfileEvaluationRuns(profileRef)).toHaveLength(2);
    expect(await store.listProfileEvaluationRuns({ ...profileRef, repositoryId: "other-repo" })).toHaveLength(0);
    expect((await store.getProfileEvaluationReceipt("profile-attempt-1"))?.contentHash).toBeDefined();
    expect((await store.getProfileEvaluationComparison(comparison.id))?.contentHash).toBe(comparison.contentHash);
    await expect(store.saveProfileEvaluationComparison({ ...profileRef, repositoryId: "other-repo" }, comparison)).rejects.toThrow("missing or mismatched run");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
