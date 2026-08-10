import { describe, expect, test, vi } from "vitest";
import {
  ModelEvaluationReceiptSchema,
  ModelEvaluationStopReceiptSchema,
} from "@openpond/contracts";

import {
  BenchmarkEvidenceSnapshot,
  BenchmarkSpendBudget,
  benchmarkAttemptsInfrastructureValid,
  benchmarkEfficiency,
  createHarnessRefinerExecutionPlan,
  totalPlannedAttempts,
} from "../apps/server/src/training/harness-refiner-benchmark-protocol.js";

describe("Harness Refiner benchmark protocol", () => {
  test("derives the four-stage forty-attempt plan from the admitted Taskset", () => {
    const tasks = [
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `adaptation-${index}`,
        split: "validation",
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `held-out-${index}`,
        split: "frozen_eval",
      })),
    ];
    const plan = createHarnessRefinerExecutionPlan({
      taskset: {
        benchmark: {
          adaptationSplit: "validation",
          evaluationSplit: "frozen_eval",
        },
        tasks,
      } as never,
      seeds: [17],
      repetitions: 1,
    });

    expect(plan.map((stage) => [stage.stage, stage.attemptCount])).toEqual([
      ["baseline", 10],
      ["adaptation", 10],
      ["candidate_adaptation", 10],
      ["candidate", 10],
    ]);
    expect(totalPlannedAttempts(plan)).toBe(40);
  });

  test("records web evidence once and replays the exact immutable result", async () => {
    const snapshot = new BenchmarkEvidenceSnapshot();
    const live = vi.fn(async () => ({
      ok: true,
      contentText: "authoritative result",
      metadata: {},
    }));
    const recorded = await snapshot.execute({
      mode: "record",
      cohort: "held_out",
      taskId: "held-out-1",
      toolName: "web_search",
      args: { query: "official source" },
      execute: live,
    });
    const replayed = await snapshot.execute({
      mode: "replay",
      cohort: "held_out",
      taskId: "held-out-1",
      toolName: "web_search",
      args: { query: "official source" },
      execute: async () => { throw new Error("live search must not run"); },
    });

    expect(live).toHaveBeenCalledOnce();
    expect(replayed).toEqual(recorded);
    expect(snapshot.manifest().observations).toHaveLength(1);
  });

  test("restores durable web evidence without invoking the live provider", async () => {
    const recorded = new BenchmarkEvidenceSnapshot();
    await recorded.execute({
      mode: "record",
      cohort: "adaptation",
      taskId: "adaptation-1",
      toolName: "web_fetch",
      args: { url: "https://example.test/source" },
      execute: async () => ({
        toolCallId: "call-1",
        name: "web_fetch",
        ok: true,
        contentText: "frozen page",
      }),
    });
    const restored = new BenchmarkEvidenceSnapshot(recorded.manifest().observations);
    const live = vi.fn(async () => {
      throw new Error("live provider must stay disabled during replay");
    });

    const replayed = await restored.execute({
      mode: "replay",
      cohort: "adaptation",
      taskId: "adaptation-1",
      toolName: "web_fetch",
      args: { url: "https://example.test/source" },
      execute: live,
    });

    expect(replayed.contentText).toBe("frozen page");
    expect(live).not.toHaveBeenCalled();
  });

  test("rejects replay when frozen web request arguments drift", async () => {
    const snapshot = new BenchmarkEvidenceSnapshot();
    await snapshot.execute({
      mode: "record",
      cohort: "held_out",
      taskId: "held-out-1",
      toolName: "web_search",
      args: { query: "original primary source" },
      execute: async () => ({
        toolCallId: "call-1",
        name: "web_search",
        ok: true,
        contentText: "frozen result",
      }),
    });

    await expect(snapshot.execute({
      mode: "replay",
      cohort: "held_out",
      taskId: "held-out-1",
      toolName: "web_search",
      args: { query: "different source" },
      execute: async () => { throw new Error("live provider must stay disabled"); },
    })).rejects.toThrow("arguments drifted");
  });

  test("enforces spend and computes publication accounting", () => {
    const budget = new BenchmarkSpendBudget(1);
    budget.charge(0.4, "baseline");
    expect(() => budget.charge(0.7, "candidate")).toThrow("maximum spend");
    expect(benchmarkEfficiency({
      baselineTokens: 1_000,
      candidateTokens: 700,
      refinerTokens: 120,
      graderTokens: 30,
    })).toEqual({
      grossForegroundTokenSavings: 300,
      overheadTokens: 150,
      firstPassNetTokenSavings: 150,
      breakEvenReuseCount: 1,
      amortizedTokenSavings: 2_850,
      amortizedReuseCount: 10,
    });
  });

  test("rejects an unlimited or invalid spend ceiling", () => {
    expect(() => new BenchmarkSpendBudget(0)).toThrow("positive finite number");
    expect(() => new BenchmarkSpendBudget(Number.NaN)).toThrow("positive finite number");
  });

  test("continues enforcing spend from a durable checkpoint", () => {
    const budget = new BenchmarkSpendBudget(1, 0.75);
    budget.charge(0.2, "resumed candidate");
    expect(budget.observedSpendUsd).toBeCloseTo(0.95);
    expect(() => budget.charge(0.06, "resumed grader")).toThrow("maximum spend");
  });

  test("fails closed when a stage has no authoritative price", () => {
    const budget = new BenchmarkSpendBudget(1);
    expect(() => budget.charge(null, "Refiner")).toThrow("spend ceiling cannot be enforced");
  });

  test("admits the complete benchmark lineage written into terminal receipts", () => {
    const hash = "a".repeat(64);
    expect(ModelEvaluationReceiptSchema.shape.lineage.parse({
      adaptationEvidenceHash: hash,
      refinerInputHash: hash,
      refinerOutcomeHash: hash,
      validationHash: hash,
      applyReceiptHash: hash,
      candidateRelease: { id: "candidate-release", contentHash: hash },
      valid: true,
    })).toMatchObject({ refinerInputHash: hash });
  });

  test("admits an inconclusive stop receipt before candidate spend", () => {
    const hash = "a".repeat(64);
    const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null };
    const core = {
      schemaVersion: "openpond.modelEvaluationStopReceipt.v1" as const,
      benchmarkId: "harness-refiner",
      terminalClassification: "inconclusive" as const,
      stopReason: "candidate_harness_unchanged" as const,
      reason: "Refiner produced no changed Harness candidate.",
      stoppedAfter: "refiner" as const,
      baselineHarness: { id: "baseline-harness", contentHash: hash },
      candidateHarness: { id: "baseline-harness", contentHash: hash },
      refiner: { id: "refiner-stage", contentHash: hash, outcomeCount: 1 },
      usage: {
        baseline: emptyUsage,
        adaptation: emptyUsage,
        candidateAdaptation: emptyUsage,
        candidate: emptyUsage,
        refiner: emptyUsage,
        grader: emptyUsage,
      },
      budget: { maximumSpendUsd: 1, observedSpendUsd: 0.2, enforced: true },
      evidenceSnapshot: { id: "evidence-snapshot", contentHash: hash },
      attempts: [],
    };
    expect(ModelEvaluationStopReceiptSchema.parse({
      ...core,
      contentHash: hash,
    })).toMatchObject({
      stopReason: "candidate_harness_unchanged",
      terminalClassification: "inconclusive",
    });
  });

  test("requires stop receipts to reduce full Harness releases to immutable refs", () => {
    const hash = "a".repeat(64);
    const fullHarness = {
      schemaVersion: "openpond.harnessRelease.v2",
      id: "candidate-harness",
      contentHash: hash,
      agentSnapshot: { id: "snapshot", contentHash: hash },
    };
    expect(() => ModelEvaluationStopReceiptSchema.parse({
      schemaVersion: "openpond.modelEvaluationStopReceipt.v1",
      benchmarkId: "harness-refiner",
      terminalClassification: "inconclusive",
      stopReason: "candidate_harness_unchanged",
      reason: "No changed candidate.",
      stoppedAfter: "refiner",
      baselineHarness: { id: "baseline-harness", contentHash: hash },
      candidateHarness: fullHarness,
      refiner: { id: "refiner-stage", contentHash: hash, outcomeCount: 1 },
      usage: Object.fromEntries(
        ["baseline", "adaptation", "candidateAdaptation", "candidate", "refiner", "grader"]
          .map((key) => [key, {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: null,
          }]),
      ),
      budget: { maximumSpendUsd: 1, observedSpendUsd: 0.2, enforced: true },
      evidenceSnapshot: { id: "evidence-snapshot", contentHash: hash },
      attempts: [],
      contentHash: hash,
    })).toThrow(/candidateHarness/);
  });

  test("rejects terminal attempts whose scores are missing because infrastructure failed", () => {
    expect(benchmarkAttemptsInfrastructureValid([
      { grade: { score: 1, failureClass: null } },
      { grade: { score: null, failureClass: "infrastructure_failure" } },
    ])).toBe(false);
    expect(benchmarkAttemptsInfrastructureValid([
      { grade: { score: 0, failureClass: "policy_failure" } },
      { grade: { score: 1, failureClass: null } },
    ])).toBe(true);
  });
});
