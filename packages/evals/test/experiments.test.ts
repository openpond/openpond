import { describe, expect, it } from "vitest";
import {
  compareExperiments,
  createExperimentManifest,
  createExperimentResult,
  verifyExperimentEvidence,
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
    name: `Model ${modelId} on dataset one`,
    teamId: "team-one",
    operationId: `operation-${modelId}`,
    maximumCostUsd: 5,
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
  // Failure story: qualified local/hosted executions must be comparable without
  // erasing placement evidence or admitting another package or metric.
  it("compares shared execution semantics while retaining exact runtime evidence", () => {
    const original = fixture("model-a");
    const withExecution = (runtime: string, change: Record<string, unknown> = {}) => {
      const {contentHash: _manifestHash, ...content} = original.manifest;
      const manifest = createExperimentManifest({...content, execution: {
        packageHash: hash("a"), runtimeTargetHash: hash(runtime), metricPolicyHash: hash("b"),
        compatibility: {protocol: "openpond.evaluation-execution.v1", targetKind: "model"}, ...change,
      }});
      const {contentHash: _resultHash, ...resultContent} = original.result;
      return {manifest, result: createExperimentResult({...resultContent,
        manifest: {id: manifest.id, contentHash: manifest.contentHash}}, manifest)};
    };
    const local = withExecution("c"), hosted = withExecution("d");
    const before = JSON.stringify([local, hosted]);
    expect(compareExperiments(local, hosted).comparable).toBe(true);
    expect(JSON.stringify([local, hosted])).toBe(before);
    expect(compareExperiments(local, withExecution("d", {packageHash: hash("e")})).reasons).toContain("different_execution_contract");
    expect(compareExperiments(local, withExecution("d", {metricPolicyHash: hash("e")})).reasons).toContain("different_execution_contract");
    expect(compareExperiments(local, withExecution("d", {compatibility: undefined})).reasons).toContain("different_execution_contract");
    expect(() => withExecution("d", {compatibility: {protocol: "openpond.evaluation-execution.v1", targetKind: "agent"}})).toThrow();

  });

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

  it("keeps the named configuration and spend ceiling inside the immutable manifest", () => {
    const original = fixture("model-a").manifest;
    const { contentHash: _hash, ...content } = original;
    expect(original.name).toBe("Model model-a on dataset one");
    expect(original.maximumCostUsd).toBe(5);
    expect(() => createExperimentManifest({
      ...content,
      name: " ",
    })).toThrow();
    expect(() => createExperimentManifest({
      ...content,
      maximumCostUsd: -1,
    })).toThrow();
  });

  it("uses matched completed feedback for deltas and excludes failed or incompatible evidence", () => {
    // Protects the portable client/web boundary from counting failed outputs as
    // measured improvement or comparing scores across different dataset pins.
    const baseline = fixture("model-a");
    const candidate = fixture("model-b");
    const { contentHash: _hash, ...candidateContent } = candidate.result;
    const revise = (status: "completed" | "failed") => ({ ...candidate,
      result: createExperimentResult({ ...candidateContent,
        cases: [{ ...candidate.result.cases[0]!, status,
          feedback: [{ ...candidate.result.cases[0]!.feedback[0]!, value: 1 }] }],
      }, candidate.manifest),
    });
    const comparison = compareExperiments(baseline, revise("completed"));
    expect(comparison.metrics[0]).toMatchObject({ eligibleCount: 1, excludedCount: 0, baseline: 0.8, candidate: 1 });
    expect(comparison.metrics[0]!.delta).toBeCloseTo(0.2);
    expect(compareExperiments(baseline, revise("failed")).cases[0]!.feedback[0]).toMatchObject({ eligible: false, reason: "case_not_completed", delta: null });
    expect(compareExperiments(baseline, fixture("model-c", hash("d"))).metrics[0]).toMatchObject({ eligibleCount: 0, excludedCount: 1, delta: null });
    const { contentHash: _manifestHash, ...manifestContent } = candidate.manifest;
    const mappedManifest = createExperimentManifest({ ...manifestContent, evaluators: candidate.manifest.evaluators.map(value => ({ ...value, configurationHash: hash("e") })) });
    const mapped = { manifest: mappedManifest, result: createExperimentResult({ ...candidateContent, manifest: { id: mappedManifest.id, contentHash: mappedManifest.contentHash } }, mappedManifest) };
    expect(compareExperiments(baseline, mapped).reasons).toContain("different_evaluators");
  });

  it("round-trips imported grader versions and unknown ceilings with bound execution lineage", () => {
    // Historical evidence must remain portable without fabricated numeric
    // revisions, spending limits or a result relabelled as another execution.
    const original = fixture("model-a");
    const { contentHash: _manifestHash, ...manifestContent } = original.manifest;
    const importedEvaluator = { ...evaluator, release: { ...evaluator.release, revision: "exact-v3" } };
    const manifest = createExperimentManifest({ ...manifestContent, maximumCostUsd: null,
      target: { kind: "fixture", configurationHash: hash("c") }, evaluators: [importedEvaluator],
      lineage: { definition: null, execution: { id: original.manifest.id, contentHash: hash("d") }, scoringPassId: null },
    });
    const { contentHash: _resultHash, ...resultContent } = original.result;
    const result = createExperimentResult({ ...resultContent,
      manifest: { id: manifest.id, contentHash: manifest.contentHash },
      cases: [{ ...original.result.cases[0]!, feedback: [{ ...original.result.cases[0]!.feedback[0]!, evaluator: importedEvaluator.release }] }],
    }, manifest);
    expect(verifyExperimentEvidence({ manifest, result })).toEqual({ manifest, result });
    const native = createExperimentManifest({ ...manifestContent, target: { kind: "harness",
      source: { profileId: "default", sourceRevision: "revision-one", harnessRelease: { id: "harness", contentHash: hash("a") },
        catalogHash: hash("b"), definitionId: "check", definitionHash: hash("c"), target: { kind: "profile" }, environmentHash: hash("d") },
      model: { modelId: "model-a", configurationHash: hash("e") } } });
    expect(native.target).toMatchObject({ kind: "harness", model: { modelId: "model-a", configurationHash: hash("e") } });
    expect(() => verifyExperimentEvidence({ manifest: native, result })).toThrow();
    const nativeTarget = native.target as Extract<typeof native.target, { kind: "harness" }>;
    const { model: _model, ...withoutModel } = nativeTarget;
    expect(() => createExperimentManifest({ ...manifestContent, target: withoutModel as never })).toThrow();

    expect(() => createExperimentManifest({ ...manifestContent,
      lineage: { definition: null, execution: { id: "another-run", contentHash: hash("d") }, scoringPassId: null },
    })).toThrow();
    expect(() => verifyExperimentEvidence({ manifest, result: { ...result, status: "failed" } })).toThrow();
  });
});
