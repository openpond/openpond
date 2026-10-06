import { describe, expect, it, vi } from "vitest";
import { createProfilePayloads } from "./profile-payloads.js";

const selection = vi.hoisted(() => ({ ref: {
  source: "local" as const, repositoryId: "repo-a", profileId: "default",
} }));

vi.mock("@openpond/cloud", async importOriginal => ({
  ...await importOriginal<typeof import("@openpond/cloud")>(),
  loadOpenPondProfileLibrary: async () => ({ lastUsed: selection.ref, profiles: [] }),
  loadOpenPondProfileStateForRef: async () => ({ mode: "local", git: { dirty: true } }),
  loadOpenPondProfileState: async () => ({ mode: "local", sourcePath: null, git: { dirty: true } }),
}));

describe("retained Profile evaluation inspection endpoint", () => {
  // Saving a report dirties Profile source. That must not hide completed
  // evidence, and switching Profiles must still deny access to that evidence.
  it("opens retained results with uncommitted source changes while enforcing the selected owner", async () => {
    const run = {
      profileRef: { ...selection.ref },
      manifest: { id: "run-1", contentHash: "a".repeat(64), profileEvaluation: { sourceRevision: "committed-source" },
        population: [{ receiptId: "receipt-1", taskId: "task-1", seed: "seed-1" }] },
      receiptRefs: [{ id: "receipt-1", contentHash: "b".repeat(64) }],
      gradeRefs: [{ id: "grade-1", contentHash: "c".repeat(64) }],
    };
    const receipt = {
      id: "receipt-1", contentHash: "b".repeat(64), taskId: "task-1", seed: "seed-1",
      runManifest: { id: "run-1", contentHash: "a".repeat(64) }, artifactRefs: [],
      graderEvidenceRefs: run.gradeRefs, latencyMs: 42, costUsd: 0.01, terminal: true,
    };
    const payloads = createProfilePayloads({
      store: {
        listProfileEvaluationRuns: async () => [run],
        listProfileEvaluationComparisons: async () => [],
        listProfileEvaluationSuiteRuns: async () => [],
        getProfileEvaluationRun: async () => run,
        getProfileEvaluationReceipt: async () => receipt,
        getProfileEvaluationGrade: async () => ({ contentHash: "c".repeat(64), score: 1, passed: true,
          gradingStatus: "scored", failureClass: null, components: [{ graderId: "correctness", graderVersion: "1",
            score: 1, passed: true, feedback: ["Expected answer returned"] }] }),
      } as unknown as Parameters<typeof createProfilePayloads>[0]["store"],
      storeDir: "/unused", appendRuntimeEvent: async () => {},
      providerSettings: async () => { throw new Error("Inspection does not run a model"); },
    });
    expect(await payloads.profileEvaluationsPayload({ runId: "run-1" })).toMatchObject({
      runId: "run-1", sourceRevision: "committed-source",
      cases: [{ taskId: "task-1", score: 1, feedback: [{ graderId: "correctness", graderVersion: "1" }] }],
    });
    expect(await payloads.profileEvaluationsPayload({ view: "history" })).toMatchObject({
      profileRef: selection.ref, runs: [run],
    });
    const original = selection.ref;
    try {
      selection.ref = { ...original, repositoryId: "repo-b" };
      await expect(payloads.profileEvaluationsPayload({ runId: "run-1" })).rejects.toThrow("selected Profile");
    } finally { selection.ref = original; }
  });
});
