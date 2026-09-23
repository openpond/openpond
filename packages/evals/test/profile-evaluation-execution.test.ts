import { expect, test, vi } from "vitest";
import { contentHash } from "@openpond/harness";

import { genericToolConformance } from "../src/conformance.js";
import { executeProfileEvaluationRun } from "../src/profile-evaluation-execution.js";
import { createTasksetRunManifest, tasksetRunMetricPolicy } from "../src/taskset-run-contract.js";

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
const manifest = createTasksetRunManifest({
  schemaVersion: "openpond.tasksetRunManifest.v1", id: "profile-evaluation-run",
  tasksetRelease: definition.tasksetRelease, packageHash: contentHash("taskset-package"),
  execution: { kind: "harness", harnessRelease }, profileEvaluation: source,
  policy: { kind: "model", model: genericToolConformance.manifest.model, configurationHash: contentHash("model-config") },
  gradingRole: "evaluation", metricPolicy: tasksetRunMetricPolicy(taskset),
  population: [{ receiptId: "profile-attempt", taskId: frozen.id, seed: "7", fixtureId: null }],
  runtimeTarget: genericToolConformance.manifest.runtimeTarget,
  limits: genericToolConformance.manifest.limits,
  createdAt: genericToolConformance.manifest.createdAt, metadata: {},
});

test("released workflow evaluation executes policy-visible cases and grades with private expected output", async () => {
  const execute = vi.fn(async (_member: { task: { input: Record<string, unknown> } }) => ({
    evidence: { output: { text: "done" }, runtimeEventRefs: [], artifactRefs: [] },
    traceHash: contentHash("real-model-trace"), artifactRefs: [],
    startedAt: manifest.createdAt, completedAt: manifest.createdAt,
    latencyMs: 0, costUsd: null, terminal: true,
  }));
  const grades: string[] = [];
  const receipts: string[] = [];
  const result = await executeProfileEvaluationRun({
    manifest, taskset, catalog, execute,
    saveGrade: async (grade) => {
      grades.push(grade.contentHash);
      return { id: "stored-grade", contentHash: grade.contentHash, mediaType: "application/json", sizeBytes: null };
    },
    saveReceipt: async (receipt) => { receipts.push(receipt.contentHash); },
  });
  expect(execute).toHaveBeenCalledOnce();
  const invoked = execute.mock.calls[0]![0].task;
  expect(invoked.input).toEqual(frozen.input);
  expect(invoked).not.toHaveProperty("expectedOutput");
  expect(invoked).not.toHaveProperty("privilegedContextRef");
  expect(result.metric.value).toBe(1);
  expect(result.passRate).toBe(1);
  expect(result.passed).toBe(true);
  expect(result.receipts[0]!.graderEvidenceRefs[0]!.contentHash).toBe(grades[0]);
  expect(receipts).toEqual([result.receipts[0]!.contentHash]);
});

test("resumes a retained member after interruption without executing or grading it again", async () => {
  let retainedGrade: Awaited<ReturnType<Parameters<typeof executeProfileEvaluationRun>[0]["saveGrade"]>> | null = null;
  let gradeValue: Parameters<Parameters<typeof executeProfileEvaluationRun>[0]["saveGrade"]>[0] | null = null;
  let receiptValue: Parameters<Parameters<typeof executeProfileEvaluationRun>[0]["saveReceipt"]>[0] | null = null;
  const execute = vi.fn(async () => ({
    evidence: { output: { text: "done" }, runtimeEventRefs: [], artifactRefs: [] },
    traceHash: contentHash("retained-trace"), artifactRefs: [],
    startedAt: manifest.createdAt, completedAt: manifest.createdAt,
    latencyMs: 0, costUsd: null, terminal: true,
  }));
  await expect(executeProfileEvaluationRun({
    manifest, taskset, catalog, execute,
    saveGrade: async (grade) => {
      gradeValue = grade;
      retainedGrade = { id: "stored-grade", contentHash: grade.contentHash, mediaType: "application/json", sizeBytes: null };
      return retainedGrade;
    },
    saveReceipt: async (receipt) => { receiptValue = receipt; throw new Error("interrupted after receipt save"); },
  })).rejects.toThrow("interrupted after receipt save");
  expect(retainedGrade).not.toBeNull();
  expect(receiptValue).not.toBeNull();
  expect(gradeValue).not.toBeNull();
  const resumedExecution = vi.fn(async () => { throw new Error("must not re-execute"); });
  const resume = () => executeProfileEvaluationRun({
    manifest, taskset, catalog, execute: resumedExecution,
    loadCompletedMember: async () => ({ receipt: receiptValue!, grade: gradeValue! }),
    saveGrade: async () => { throw new Error("must not re-grade"); },
    saveReceipt: async () => { throw new Error("must not re-save"); },
  });
  const result = await resume();
  expect(result.receipts).toEqual([receiptValue]);
  expect(result.passRate).toBe(1);
  expect(resumedExecution).not.toHaveBeenCalled();
  receiptValue = { ...receiptValue!, taskId: "another-task" };
  await expect(resume()).rejects.toThrow("differs from its admitted evidence");
});
