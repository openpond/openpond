import { ModelComparisonBenchmarkReceiptSchema, ModelRunSchema, type ModelComparisonSeries, type ModelComparisonSeriesEntry, type ModelRun } from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import { describe, expect, it } from "vitest";

import {
  createModelComparisonEvaluationService,
  resolveComparisonPanel,
  settleComparisonEvaluationLifecycle,
} from "./model-comparison-evaluation-service.js";

const hash = (value: unknown) => contentHash(value);
const ref = (id: string) => ({ id, revision: 1, contentHash: hash(id) });
const NOW = "2026-09-02T12:00:00.000Z";

describe("Model Comparison evaluation evidence controls", () => {
  it("binds exact disclosed panels while rejecting mismatches, optimizer panels, and future disclosure", () => {
    const series = fixtureSeries();
    const entry = { id: "entry-p0", label: "P0", ordinal: 0, taskset: ref("p0-correction") } as ModelComparisonSeriesEntry;
    expect(resolveComparisonPanel(series, entry, "correction", "panel-p0", ref("p0-correction"))).toMatchObject({ panel: { id: "panel-p0", role: "correction" }, taskset: ref("p0-correction") });
    expect(() => resolveComparisonPanel(series, entry, "correction", "panel-p0", ref("wrong"))).toThrow("does not match");
    expect(() => resolveComparisonPanel(series, entry, "prior_disclosed", "panel-p1", ref("p1-correction"))).toThrow("future");
    expect(() => resolveComparisonPanel(series, entry, "prior_disclosed", "panel-eligible", ref("eligible"))).toThrow("not part");
    expect(() => resolveComparisonPanel(series, null, "prior_disclosed", "panel-p0", ref("p0-correction"))).toThrow("entry context");
  });

  it("terminally reconciles prepared and running attempts after a process restart", async () => {
    const runs = new Map<string, ModelRun>([
      ["prepared-run", preparedRun("prepared-run", "prepared")],
      ["running-run", preparedRun("running-run", "running")],
      ["terminal-run", preparedRun("terminal-run", "failed")],
    ]);
    const store = {
      listModelRuns: async () => [...runs.values()],
      saveModelRun: async (run: ModelRun) => { runs.set(run.id, run); return run; },
    };
    const service = createModelComparisonEvaluationService({ store: store as never, storeDir: "/tmp", comparisonSeries: {} as never });
    await service.reconcileInterrupted();
    expect(runs.get("prepared-run")).toMatchObject({ status: "failed", failure: expect.stringContaining("restarted") });
    expect(runs.get("running-run")).toMatchObject({ status: "failed", failure: expect.stringContaining("restarted") });
    expect(runs.get("terminal-run")?.failure).toBe("already terminal");
  });

  it("reconciles the next automatic Evaluation only after serving cleanup", async () => {
    const events: string[] = [];
    await settleComparisonEvaluationLifecycle({
      cleanup: async () => { events.push("cleanup"); },
      reconcileAutomatic: async () => { events.push("reconcile"); },
    });
    expect(events).toEqual(["cleanup", "reconcile"]);
  });

  it("continues bounded automatic reconciliation when cleanup already failed", async () => {
    const events: string[] = [];
    await settleComparisonEvaluationLifecycle({
      cleanup: async () => {
        events.push("cleanup");
        throw new Error("cleanup failed");
      },
      reconcileAutomatic: async () => { events.push("reconcile"); },
    });
    expect(events).toEqual(["cleanup", "reconcile"]);
  });

  it("requires terminal managed-serving spend and zero active resources in benchmark receipts", () => {
    const managedServing = {
      jobId: "job-1",
      terminalState: "cancelled" as const,
      sourcePolicyVersion: 0,
      sourceAdapterSha256: null,
      servedPolicyVersion: 0,
      servedAdapterSha256: hash("adapter"),
      accruedSpendUsd: 0.75,
      cleanupAttestationHash: hash("cleanup"),
      resourceCount: 1,
      activeResourceCount: 0 as const,
    };
    const receipt = benchmarkReceipt(managedServing);
    expect(ModelComparisonBenchmarkReceiptSchema.parse(receipt).managedServing).toEqual(managedServing);
    expect(() => ModelComparisonBenchmarkReceiptSchema.parse({
      ...receipt,
      managedServing: { ...managedServing, activeResourceCount: 1 },
    })).toThrow();
  });
});

function fixtureSeries(): ModelComparisonSeries {
  return {
    schedule: [
      { id: "schedule-p0", ordinal: 0, label: "P0" },
      { id: "schedule-p1", ordinal: 1, label: "P1" },
    ],
    evaluationTasksets: { development: ref("development"), retained: ref("retained"), frozenFinal: ref("frozen") },
    benchmarkProtocol: {
      panels: [
        { id: "panel-p0", role: "correction", passLabel: "P0", taskset: ref("p0-correction") },
        { id: "panel-p1", role: "correction", passLabel: "P1", taskset: ref("p1-correction") },
        { id: "panel-eligible", role: "training_eligible", passLabel: null, taskset: ref("eligible") },
      ],
    },
  } as unknown as ModelComparisonSeries;
}

function preparedRun(id: string, status: "prepared" | "running" | "failed"): ModelRun {
  const taskset = ref("taskset");
  return ModelRunSchema.parse({
    schemaVersion: "openpond.modelRun.v1", id, modelId: "model", modelVersionId: "version", profileId: "profile", kind: "evaluation", status, method: null, destinationId: null, taskset, comparisonSeriesEntry: null,
    harnessRelease: { id: "harness", contentHash: hash("harness") }, quote: { maximumSpendUsd: 1, hourlyCostUsd: null },
    evaluation: { benchmarkId: "model-comparison", target: { kind: "model_version", label: "candidate", modelVersionId: "version", model: null }, grader: { id: "grader", contentHash: hash("grader") }, judge: null, seeds: [1], repetitions: 1, maximumSpendUsd: 1, series: null, panel: null, comparisonPair: null, attemptPlan: [{ stage: "comparison", split: "current", taskIds: ["task"], attemptCount: 1 }] },
    evaluationProgress: { stage: "comparison", completedAttempts: 0, totalAttempts: 1, accounting: null, evidenceSnapshot: null }, reward: null, receipt: null, adapterArtifactLineageId: null,
    failure: status === "failed" ? "already terminal" : null, startedAt: NOW, completedAt: status === "failed" ? NOW : null, updatedAt: NOW,
  });
}

function benchmarkReceipt(managedServing: Record<string, unknown>) {
  const content = {
    schemaVersion: "openpond.modelComparisonBenchmarkReceipt.v1" as const,
    benchmarkId: "model-comparison" as const,
    target: { kind: "model_version" as const, label: "candidate", modelVersionId: "version", model: null },
    taskset: ref("taskset"),
    grader: { id: "grader", contentHash: hash("grader") },
    sampling: { seeds: [1], repetitions: 1 },
    deterministic: { attemptedTaskCount: 0, completedTaskCount: 0, passedTaskCount: 0, failedTaskCount: 0, meanScore: null, passRate: null, passRateCi95: null },
    judge: null,
    attempts: [],
    usage: { policy: null, judge: null, observedSpendUsd: 0.75, evaluationGpuSeconds: 1 },
    managedServing,
    evidenceSnapshot: { id: "evidence", contentHash: hash("evidence"), artifactPath: "/tmp/evidence.json" },
    completedAt: NOW,
  };
  return { ...content, contentHash: hash(content) };
}
