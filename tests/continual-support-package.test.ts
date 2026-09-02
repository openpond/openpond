import {
  auditContinualBenchLeakage,
  contentHash,
  createContinualBenchReport,
  createContinualBenchSplit,
  exportContinualBenchReport,
  pairedBootstrapEstimate,
  sealPortableManifest,
  validateContinualBenchManifest,
  verifyProtocol,
} from "@openpond/continual-support";
import { contentHash as tasksetContentHash } from "@openpond/taskset-sdk";
import { describe, expect, it } from "vitest";

const task = (id: string, familyId: string, prompt = id) => ({ id, familyId, prompt, contentHash: contentHash({ id, familyId, prompt }) });

describe("@openpond/continual-support", () => {
  it("uses OpenPond canonical content hashing", () => {
    const value = { z: 1, a: [{ b: 2, a: null }] };
    expect(contentHash(value)).toBe(tasksetContentHash(value));
  });
  it("allocates whole issue families deterministically without exposing siblings", () => {
    const input = {
      tasks: [task("a1", "family-a"), task("a2", "family-a"), task("a3", "family-a"), task("b1", "family-b")],
      passes: [{ label: "P1", familyIds: ["family-a"] }],
      seed: "sealed-seed-v1",
    };
    const first = createContinualBenchSplit(input);
    const second = createContinualBenchSplit({ ...input, tasks: [...input.tasks].reverse() });
    expect(first).toEqual(second);
    expect(first.families[0]?.correctionTaskIds).toHaveLength(1);
    expect(first.families[0]?.siblingTaskIds).toHaveLength(2);
    expect(first.allocations.filter((entry) => entry.optimizerEligible)).toHaveLength(1);
    expect(first.advisories).toContainEqual({ code: "unassigned_family", familyId: "family-b", taskCount: 1 });
  });

  it("reports insufficient families rather than fabricating siblings", () => {
    const split = createContinualBenchSplit({ tasks: [task("a1", "family-a")], passes: [{ label: "P1", familyIds: ["family-a"] }], seed: "seed" });
    expect(split.allocations).toHaveLength(0);
    expect(split.advisories).toEqual([{ code: "insufficient_siblings", familyId: "family-a", taskCount: 1 }]);
  });

  it("can select the correction case with the least near-duplicate sibling exposure", () => {
    const split = createContinualBenchSplit({
      tasks: [
        task("a1", "family-a", "return the exact blue camera to card one"),
        task("a2", "family-a", "return the exact blue camera to card two"),
        task("a3", "family-a", "exchange headphones after confirming the order"),
      ],
      passes: [{ label: "P1", familyIds: ["family-a"] }],
      seed: "seed",
      correctionSelection: "minimize_prompt_similarity",
    });
    expect(split.families[0]?.correctionTaskIds).toEqual(["a3"]);
  });

  it("audits forbidden family and near-duplicate leakage while allowing declared correction/sibling sharing", () => {
    const correction = task("a1", "family-a", "Please return the blue camera to my card");
    const sibling = task("a2", "family-a", "Please return my blue camera to the card");
    const retained = task("r1", "family-a", "A retained anchor");
    const audit = auditContinualBenchLeakage({
      panels: [{ id: "correction", tasks: [correction] }, { id: "sibling", tasks: [sibling] }, { id: "retained", tasks: [retained] }],
      semanticSimilarityThreshold: 0.7,
      allowSharedFamiliesBetween: [["correction", "sibling"]],
    });
    expect(audit.findings.some((finding) => finding.kind === "prompt_overlap" && finding.rightPanel === "sibling")).toBe(true);
    expect(audit.findings.some((finding) => finding.kind === "family_overlap" && finding.rightPanel === "retained")).toBe(true);
  });

  it("rejects a protocol whose immutable hash was changed", () => {
    expect(() => verifyProtocol({ contentHash: "0".repeat(64) } as never)).toThrow();
  });

  it("computes deterministic paired confidence intervals and an exact sign test", () => {
    const input = {
      observations: [
        { id: "a", candidate: 1, reference: 0 },
        { id: "b", candidate: 0.8, reference: 0.4 },
        { id: "c", candidate: 0.2, reference: 0.5 },
      ],
      samples: 2_000,
      seed: 17,
    };
    const first = pairedBootstrapEstimate(input);
    expect(pairedBootstrapEstimate(input)).toEqual(first);
    expect(first).toMatchObject({ candidateWins: 2, referenceWins: 1, ties: 0 });
    expect(first.confidenceInterval[0]).toBeLessThanOrEqual(first.meanDifference);
    expect(first.confidenceInterval[1]).toBeGreaterThanOrEqual(first.meanDifference);
  });

  it("seals portable manifests and receipt-shaped reports", () => {
    const source = task("correction", "family-a", "correct one");
    const sibling = task("sibling", "family-a", "verify another");
    const manifest = sealPortableManifest({
      schemaVersion: "openpond.continualBenchManifest.v1",
      id: "fixture", revision: 1, name: "Fixture", description: "Portable fixture", license: "MIT",
      source: { repository: null, commit: null, generatedBy: "test" },
      split: { seed: "seed", correctionCasesPerFamily: 1, correctionSelection: "stable_hash", semanticSimilarityThreshold: 0.9 },
      passes: [{ label: "P0", familyIds: ["family-a"] }],
      tasks: [source, sibling],
      panels: [
        { id: "p0-correction", role: "correction", passLabel: "P0", taskIds: [source.id], disclosurePhase: "review", optimizerEligible: true },
        { id: "p0-siblings", role: "sibling_verification", passLabel: "P0", taskIds: [sibling.id], disclosurePhase: "evaluation", optimizerEligible: false },
      ],
      grader: { id: "grader", contentHash: contentHash("grader"), outcomeScale: { minimum: 0, maximum: 1 } },
      evaluation: { seeds: [1, 2, 3], repetitions: 3, confidenceLevel: 0.95, pairedBootstrapSamples: 10_000 },
    });
    expect(validateContinualBenchManifest(manifest).valid).toBe(true);
    const report = createContinualBenchReport({
      schemaVersion: "openpond.continualBenchReport.v1",
      seriesId: "series", protocol: { id: "protocol", revision: 1, contentHash: manifest.contentHash },
      generatedAt: "2026-09-01T00:00:00.000Z", status: "terminal",
      points: [{ id: "p0", label: "P0", kind: "candidate", ordinal: 0, meanScore: 0.8, confidenceInterval: [0.7, 0.9], taskMetrics: [], efficiency: null, evidenceUrl: null }],
      outcomes: ["correction_absorbed"], audit: [],
    });
    expect(JSON.parse(exportContinualBenchReport(report))).toEqual(report);
  });
});
