import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { BenchmarkEvidenceSnapshot, BenchmarkSpendBudget } from
  "../apps/server/src/training/harness-refiner-benchmark-protocol.js";
import { BenchmarkRefinerInvocationError } from
  "../apps/server/src/training/harness-refiner-benchmark-refiner-stage.js";
import { loadSequentialAdaptationCheckpoint } from
  "../apps/server/src/training/harness-refiner-benchmark-sequential-checkpoint.js";
import { runSequentialHarnessAdaptation } from
  "../apps/server/src/training/harness-refiner-benchmark-sequential-stage.js";

const NOW = "2026-08-18T20:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe("sequential Harness adaptation recovery", () => {
  test("resumes a timed-out Refiner from the same attempt and is idempotent", async () => {
    const fixture = await recoveryFixture();
    let taskBInvocations = 0;
    const runRefinerAfterAttempt = vi.fn(async ({ result }: {
      result: { attempt: { taskId: string } };
    }) => {
      if (result.attempt.taskId === "task-a") {
        fixture.currentHash = HASH_B;
        return completedRefiner("task-a", HASH_B);
      }
      taskBInvocations += 1;
      if (taskBInvocations === 1) {
        throw invocationFailure({
          taskId: "task-b",
          costBasis: "estimated",
          estimatedCostUsd: 0.002,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null },
        });
      }
      return completedRefiner("task-b", HASH_B);
    });

    await expect(fixture.run(runRefinerAfterAttempt)).rejects.toThrow("timed out");
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    let checkpoint = await loadSequentialAdaptationCheckpoint({
      storeDir: fixture.directory,
      modelRunId: "model-run-resume",
    });
    expect(checkpoint?.steps).toMatchObject([
      { taskId: "task-a", attemptId: "attempt-task-a" },
    ]);
    expect(checkpoint?.invocations).toEqual(expect.arrayContaining([expect.objectContaining({
        taskId: "task-b",
        attemptId: "attempt-task-b",
        status: "failed",
        failure: expect.objectContaining({ kind: "timeout", retryable: true }),
        costBasis: "estimated",
        estimatedCostUsd: 0.002,
      })]));

    const resumed = await fixture.run(runRefinerAfterAttempt);
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(resumed.summary.steps.map((step) => step.taskId)).toEqual(["task-a", "task-b"]);
    expect(resumed.attempts.map((attempt) => attempt.attempt.id)).toEqual([
      "attempt-task-a",
      "attempt-task-b",
    ]);

    const duplicateResume = await fixture.run(runRefinerAfterAttempt);
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(runRefinerAfterAttempt).toHaveBeenCalledTimes(3);
    expect(duplicateResume.summary.contentHash).toBe(resumed.summary.contentHash);
    checkpoint = await loadSequentialAdaptationCheckpoint({
      storeDir: fixture.directory,
      modelRunId: "model-run-resume",
    });
    expect(checkpoint?.steps).toHaveLength(2);
  });

  test("records usage observed before timeout and stops after the bounded retry", async () => {
    const fixture = await recoveryFixture(["task-a"]);
    const runRefinerAfterAttempt = vi.fn(async () => {
      throw invocationFailure({
        taskId: "task-a",
        costBasis: "authoritative",
        estimatedCostUsd: null,
        usage: { inputTokens: 120, outputTokens: 9, totalTokens: 129, costUsd: 0.004 },
      });
    });

    await expect(fixture.run(runRefinerAfterAttempt)).rejects.toThrow("timed out");
    await expect(fixture.run(runRefinerAfterAttempt)).rejects.toThrow("timed out");
    await expect(fixture.run(runRefinerAfterAttempt)).rejects.toThrow(
      "exhausted 2 admitted invocations",
    );
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(runRefinerAfterAttempt).toHaveBeenCalledTimes(2);
    const checkpoint = await loadSequentialAdaptationCheckpoint({
      storeDir: fixture.directory,
      modelRunId: "model-run-resume",
    });
    expect(checkpoint?.invocations).toHaveLength(2);
    expect(checkpoint?.invocations[1]).toMatchObject({
      status: "failed",
      usage: { inputTokens: 120, outputTokens: 9, totalTokens: 129, costUsd: 0.004 },
      costBasis: "authoritative",
      estimatedCostUsd: null,
    });
  });
});

async function recoveryFixture(taskIds = ["task-a", "task-b"]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-sequential-resume-"));
  directories.push(directory);
  const evidenceById = new Map<string, any>();
  const fixture = {
    directory,
    currentHash: HASH_A,
    execute: vi.fn(async ({ taskId }: { taskId: string }) => {
      const evidence = attemptEvidence(taskId);
      evidenceById.set(evidence.attempt.id, evidence);
      return {
        attempt: evidence.attempt,
        grade: evidence.grade,
        artifacts: evidence.artifacts,
        portable: {
          receipt: { contentHash: evidence.receiptContentHash },
          artifactManifest: evidence.artifactManifest,
          rewardReceipt: evidence.rewardReceipt,
        },
      };
    }),
    async run(runRefinerAfterAttempt: ReturnType<typeof vi.fn>) {
      return runSequentialHarnessAdaptation({
        store: {
          setHarnessBackgroundReviewSettings: vi.fn(async () => undefined),
          getHarnessWorkspace: vi.fn(async () => ({
            id: "workspace",
            currentChannel: {
              release: releaseRef(fixture.currentHash),
            },
          })),
          getHarnessReleaseRecord: vi.fn(async (hash: string) => ({
            harnessRelease: releaseRef(hash),
            agentSnapshot: { id: `agent-${hash.slice(0, 8)}`, contentHash: hash },
          })),
          listHarnessImprovementArtifacts: vi.fn(async () => []),
        } as never,
        storeDir: directory,
        evaluation: { execute: fixture.execute } as never,
        modelRun: { id: "model-run-resume" } as never,
        model: { providerId: "openpond", modelId: "openpond-chat" } as never,
        reasoningEffort: "high",
        taskset: { id: "taskset", tasks: [] } as never,
        taskIds,
        seed: 17,
        initialRuntime: runtime(HASH_A) as never,
        evidenceSnapshot: new BenchmarkEvidenceSnapshot(),
        budget: new BenchmarkSpendBudget(1),
        admittedPricing: {} as never,
        refinerStream: async function* () {},
        signal: new AbortController().signal,
        now: () => NOW,
        onAttemptComplete: async () => undefined,
        adapters: {
          runRefinerAfterAttempt: runRefinerAfterAttempt as never,
          loadRuntimeFromRelease: (async ({ release }: any) =>
            runtime(release.harnessRelease.contentHash)) as never,
          loadAttemptEvidenceByIds: (async ({ attemptIds }: { attemptIds: string[] }) =>
            attemptIds.map((id) => evidenceById.get(id))) as never,
          buildLineage: (async () => ({
            adaptationEvidenceHash: "1".repeat(64),
            refinerInputHash: "2".repeat(64),
            refinerOutcomeHash: "3".repeat(64),
            validationHash: "4".repeat(64),
            applyReceiptHash: "5".repeat(64),
            candidateRelease: releaseRef(fixture.currentHash),
            valid: true,
          })) as never,
        },
      });
    },
  };
  return fixture;
}

function runtime(hash: string) {
  return {
    workspace: { id: "workspace", currentChannel: { release: releaseRef(hash) } },
    release: {
      harnessRelease: releaseRef(hash),
      agentSnapshot: { id: `agent-${hash.slice(0, 8)}`, contentHash: hash },
    },
    instructionContext: `Harness ${hash}`,
  };
}

function releaseRef(hash: string) {
  return { id: `harness-${hash.slice(0, 8)}`, contentHash: hash };
}

function attemptEvidence(taskId: string) {
  const attemptId = `attempt-${taskId}`;
  return {
    attempt: {
      id: attemptId,
      taskId,
      infrastructureError: null,
      costUsd: 0.01,
      latencyMs: 100,
      metadata: { usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    },
    grade: { id: `grade-${taskId}`, passed: true },
    artifacts: [],
    receiptContentHash: HASH_C,
    artifactManifest: { id: `manifest-${taskId}`, contentHash: HASH_A },
    rewardReceipt: { id: `reward-${taskId}`, contentHash: HASH_B },
  };
}

function completedRefiner(taskId: string, outputHash: string) {
  return {
    detection: {
      trigger: {
        id: `trigger-${taskId}`,
        contentHash: HASH_C,
        decision: "queue_refiner",
      },
    },
    result: {
      outcome: {
        id: `outcome-${taskId}`,
        contentHash: HASH_B,
        decision: "no_action",
      },
    },
    invocation: {
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001 },
      costBasis: "authoritative",
      estimatedCostUsd: null,
      startedAt: NOW,
      completedAt: NOW,
    },
    outputHash,
  };
}

function invocationFailure(input: {
  taskId: string;
  costBasis: "authoritative" | "estimated" | "none";
  estimatedCostUsd: number | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number | null };
}) {
  return new BenchmarkRefinerInvocationError("Refiner timed out after 60000ms.", {
    trigger: {
      id: `trigger-${input.taskId}`,
      contentHash: HASH_C,
    } as never,
    usage: input.usage,
    costBasis: input.costBasis,
    estimatedCostUsd: input.estimatedCostUsd,
    failureKind: "timeout",
    retryable: true,
    startedAt: NOW,
    completedAt: NOW,
  });
}
