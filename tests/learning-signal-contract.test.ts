import {
  LearningSignalEnvelopeSchema,
  type LearningSignalEnvelope,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { describe, expect, test } from "vitest";

const lineage = {
  datasetRelease: { id: "dataset-1", contentHash: sha256("dataset") },
  harnessRelease: { id: "harness-1", contentHash: sha256("harness") },
  evidenceSetRelease: null,
  profileRelease: null,
  model: {
    source: "local",
    revision: "model-revision",
    artifactHash: null,
  },
  environmentHash: sha256("environment"),
  graderHash: sha256("grader"),
  toolContractHash: sha256("tools"),
  verificationReceiptHash: sha256("verification"),
};

function trajectory(
  optimizerSample: Record<string, unknown>,
): LearningSignalEnvelope {
  const base = {
    schemaVersion: "openpond.learningSignal.v1" as const,
    id: "trajectory-1",
    taskId: "task-1",
    episodeId: "episode-1",
    policyVersion: 0,
    lineage,
    approved: true,
    verifier: "deterministic" as const,
    createdAt: "2026-07-23T12:00:00.000Z",
    metadata: {},
    kind: "trajectory" as const,
    payload: {
      traceRef: "r2://traces/episode-1.json",
      traceHash: sha256("trace"),
      terminal: true,
      failureClass: null,
      optimizerSample,
    },
  };
  return LearningSignalEnvelopeSchema.parse({
    ...base,
    contentHash: contentHash(base),
  });
}

describe("optimizer-ready learning signals", () => {
  test("bind token-level rollout facts without embedding provider state", () => {
    const parsed = trajectory({
      schemaVersion: "openpond.optimizerTrainingSample.v1",
      tokenIds: [1, 2, 3],
      mask: [false, true, true],
      logprobs: [0, -0.1, -0.2],
      temperatures: [0.8, 0.8, 0.8],
      envName: "fixture",
      modelRequestId: "request-1",
      promptTokenCount: 1,
      completionTokenCount: 2,
      servedPolicyVersion: 0,
    });
    expect(parsed.kind).toBe("trajectory");
    if (parsed.kind === "trajectory") {
      expect(parsed.payload.optimizerSample?.tokenIds).toEqual([1, 2, 3]);
    }
  });

  test("rejects misaligned optimizer arrays and trainable prompt tokens", () => {
    expect(() =>
      trajectory({
        schemaVersion: "openpond.optimizerTrainingSample.v1",
        tokenIds: [1, 2, 3],
        mask: [true, true],
        logprobs: [0, -0.1, -0.2],
        temperatures: [0.8, 0.8, 0.8],
        envName: "fixture",
        modelRequestId: "request-1",
        promptTokenCount: 1,
        completionTokenCount: 2,
        servedPolicyVersion: 0,
      }),
    ).toThrow();
  });
});
