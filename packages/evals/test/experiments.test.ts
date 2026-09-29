import { describe, expect, it } from "vitest";
import {
  compareExperiments,
  createExperimentManifest,
  createExperimentResult,
} from "../src/experiments.js";

const hash = (digit: string) => digit.repeat(64);
const evaluator = {
  release: { id: "accuracy", revision: 1, contentHash: hash("b") },
  feedbackKey: "accuracy",
  output: "score" as const,
  categories: [],
};
const identity = { caseId: "case-one", seed: "0", fixtureId: null };

function fixture(modelId: string, datasetHash = hash("a")) {
  const manifest = createExperimentManifest({
    schemaVersion: "openpond.experimentManifest.v1",
    id: `experiment-${modelId}`,
    teamId: "team-one",
    operationId: `operation-${modelId}`,
    dataset: { id: "dataset-one", revision: 1, contentHash: datasetHash },
    target: { kind: "model", modelId, configurationHash: hash("c") },
    evaluators: [evaluator],
    population: [identity],
    createdAt: "2026-09-29T12:00:00.000Z",
  });
  const result = createExperimentResult({
    schemaVersion: "openpond.experimentResult.v1",
    manifest: { id: manifest.id, contentHash: manifest.contentHash },
    status: "completed",
    cases: [{
      identity,
      status: "completed",
      output: { text: modelId },
      error: null,
      feedback: [{
        feedbackKey: "accuracy",
        evaluator: evaluator.release,
        status: "scored",
        value: 0.8,
        reasoning: null,
        evidenceRefs: [],
      }],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001, latencyMs: 30 },
      traceRef: null,
      startedAt: "2026-09-29T12:00:00.000Z",
      completedAt: "2026-09-29T12:00:01.000Z",
    }],
    completedAt: "2026-09-29T12:00:01.000Z",
  }, manifest);
  return { manifest, result };
}

describe("portable experiment evidence", () => {
  it("aligns two retained model runs without changing their evidence", () => {
    const baseline = fixture("model-a");
    const candidate = fixture("model-b");
    const comparison = compareExperiments(baseline, candidate);
    expect(comparison.comparable).toBe(true);
    expect(comparison.cases).toHaveLength(1);
    expect(comparison.cases[0]?.baseline?.output).toEqual({ text: "model-a" });
    expect(comparison.cases[0]?.candidate?.output).toEqual({ text: "model-b" });
  });

  it("blocks a scored delta across dataset versions and detects altered feedback", () => {
    const baseline = fixture("model-a");
    const candidate = fixture("model-b", hash("d"));
    expect(compareExperiments(baseline, candidate).reasons).toContain("different_dataset_version");
    expect(() => createExperimentResult({
      ...baseline.result,
      cases: [{ ...baseline.result.cases[0]!, feedback: [{ ...baseline.result.cases[0]!.feedback[0]!, value: 2 }] }],
    }, baseline.manifest)).toThrow();
  });
});
