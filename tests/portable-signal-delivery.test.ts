import {
  LearningSignalBatchSchema,
  type LearningSignalBatch,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { describe, expect, test, vi } from "vitest";

import { PortableDestinationEngineBridge } from "../apps/server/src/training/portable-destination-engine.ts";

describe("portable online signal delivery", () => {
  test("delivers contiguous manifest-bound batches once and rejects drift", async () => {
    const delivered = vi.fn(async () => undefined);
    const bridge = new PortableDestinationEngineBridge({
      adapterId: "local-trl",
      capabilities: vi.fn(),
      launch: vi.fn(),
      status: vi.fn(),
      cancel: vi.fn(),
      collect: vi.fn(),
      events: vi.fn(),
      deliverSignals: delivered,
    } as never);
    const internals = bridge as unknown as {
      manifestHashes: Map<string, string>;
      manifestIds: Map<string, string>;
    };
    internals.manifestHashes.set("run-signals", sha256("manifest"));
    internals.manifestIds.set("run-signals", "manifest-signals");
    const worker = bridge.localWorker();
    const ref = {
      runId: "run-signals",
      adapterId: "local-trl",
      providerJobId: null,
      leaseId: null,
      createdAt: "2026-07-25T12:00:00.000Z",
    };
    const first = signalBatch(0);

    await worker.consumeSignals(ref, first);
    await worker.consumeSignals(ref, first);
    expect(delivered).toHaveBeenCalledTimes(1);

    await expect(
      worker.consumeSignals(ref, signalBatch(2)),
    ).rejects.toThrow("not contiguous");
    await expect(
      worker.consumeSignals(ref, {
        ...first,
        contentHash: sha256("changed"),
      }),
    ).rejects.toThrow("content hash is invalid");
  });
});

function signalBatch(sequence: number): LearningSignalBatch {
  const lineage = {
    datasetRelease: { id: "dataset", contentHash: sha256("dataset") },
    harnessRelease: { id: "harness", contentHash: sha256("harness") },
    evidenceSetRelease: null,
    profileRelease: null,
    model: {
      source: "fixture",
      revision: "fixture-revision",
      artifactHash: null,
    },
    environmentHash: sha256("environment"),
    graderHash: sha256("grader"),
    toolContractHash: sha256("tools"),
    verificationReceiptHash: null,
  };
  const signalCore = {
    schemaVersion: "openpond.learningSignal.v1" as const,
    id: `trajectory-${sequence}`,
    taskId: "task",
    episodeId: `episode-${sequence}`,
    policyVersion: 0,
    lineage,
    approved: true,
    verifier: "deterministic" as const,
    createdAt: "2026-07-25T12:00:00.000Z",
    metadata: {},
    kind: "trajectory" as const,
    payload: {
      traceRef: `traces/${sequence}.json`,
      traceHash: sha256(`trace-${sequence}`),
      terminal: true,
      failureClass: null,
      optimizerSample: null,
    },
  };
  const core = {
    schemaVersion: "openpond.learningSignalBatch.v1" as const,
    manifestId: "manifest-signals",
    manifestHash: sha256("manifest"),
    sequence,
    signals: [{
      ...signalCore,
      contentHash: contentHash(signalCore),
    }],
  };
  return LearningSignalBatchSchema.parse({
    ...core,
    contentHash: contentHash(core),
  });
}
