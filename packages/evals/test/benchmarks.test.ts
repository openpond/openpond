import { describe, expect, it } from "vitest";

import { contentHash } from "@openpond/harness";

import {
  aggregateEvaluationReceipts,
  createAttemptReceipt,
} from "../src/runs.js";
import {
  compareBenchmarkRuns,
  createBenchmarkRunSummary,
} from "../src/benchmarks.js";
import { genericToolConformance } from "../src/conformance.js";

const CREATED_AT = "2026-08-09T12:00:00.000Z";

describe("benchmark contracts", () => {
  it("compares token use only after quality holds under the pinned protocol", () => {
    const baseline = benchmarkRun("baseline", 1_000, true);
    const candidate = benchmarkRun("candidate", 700, true);

    const comparison = compareBenchmarkRuns({
      id: "comparison-1",
      baseline,
      candidate,
      primaryMetric: "foreground_tokens",
      qualityGate: "non_regression",
      createdAt: CREATED_AT,
    });

    expect(comparison).toMatchObject({
      qualityPassed: true,
      foregroundTokenDelta: -300,
      foregroundTokenDeltaPercent: -30,
      improved: true,
    });
  });

  it("does not call a cheaper candidate an improvement when quality regresses", () => {
    const baseline = benchmarkRun("baseline", 1_000, true);
    const candidate = benchmarkRun("candidate", 700, false);

    const comparison = compareBenchmarkRuns({
      id: "comparison-2",
      baseline,
      candidate,
      primaryMetric: "foreground_tokens",
      qualityGate: "non_regression",
      createdAt: CREATED_AT,
    });

    expect(comparison).toMatchObject({
      qualityPassed: false,
      improved: false,
    });
  });

  it("does not pass the quality gate when both phases have zero successful attempts", () => {
    const baseline = benchmarkRun("baseline", 1_000, false);
    const candidate = benchmarkRun("candidate", 700, false);

    const comparison = compareBenchmarkRuns({
      id: "comparison-empty-quality",
      baseline,
      candidate,
      primaryMetric: "foreground_tokens",
      qualityGate: "non_regression",
      createdAt: CREATED_AT,
    });

    expect(comparison).toMatchObject({
      qualityPassed: false,
      improved: false,
    });
  });

  it("rejects comparisons across different model configurations", () => {
    const baseline = benchmarkRun("baseline", 1_000, true);
    const candidate = {
      ...benchmarkRun("candidate", 700, true),
      reasoningEffort: "medium",
    };

    expect(() => compareBenchmarkRuns({
      id: "comparison-3",
      baseline,
      candidate,
      primaryMetric: "foreground_tokens",
      qualityGate: "non_regression",
      createdAt: CREATED_AT,
    })).toThrow("pinned protocol");
  });
});

function benchmarkRun(
  phase: "baseline" | "candidate",
  totalTokens: number,
  passed: boolean,
) {
  const manifest = genericToolConformance.manifest;
  const receipt = createAttemptReceipt({
    schemaVersion: "openpond.attemptReceipt.v1",
    id: `${phase}-receipt`,
    runManifest: { id: manifest.id, contentHash: manifest.contentHash },
    taskId: genericToolConformance.taskset.tasks[0]!.id,
    seed: "17",
    terminal: true,
    failureClass: null,
    outputHash: contentHash(`${phase}-output`),
    traceHash: contentHash(`${phase}-trace`),
    artifactRefs: [],
    graderEvidenceRefs: [],
    startedAt: CREATED_AT,
    completedAt: CREATED_AT,
    latencyMs: 1_000,
    costUsd: 0.01,
    metadata: {
      passed,
      rewardEligible: true,
      score: passed ? 1 : 0,
      usage: {
        input_tokens: totalTokens - 100,
        output_tokens: 100,
        total_tokens: totalTokens,
      },
    },
  });
  const evaluation = aggregateEvaluationReceipts({
    id: `${phase}-evaluation`,
    manifest,
    receipts: [receipt],
  });
  return createBenchmarkRunSummary({
    id: `${phase}-summary`,
    phase,
    evaluation,
    receipts: [receipt],
    reasoningEffort: "high",
    protocol: {
      split: "frozen_eval",
      taskIds: [genericToolConformance.taskset.tasks[0]!.id],
      seeds: ["17"],
      repetitions: 1,
      runtimeTargetHash: contentHash(manifest.runtimeTarget),
      environmentHash: contentHash(genericToolConformance.taskset.environment),
      toolContractHash: contentHash(genericToolConformance.taskset.tools),
      limitsHash: contentHash(manifest.limits),
    },
    createdAt: CREATED_AT,
  });
}
