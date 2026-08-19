import { describe, expect, test, vi } from "vitest";

import { BenchmarkEvidenceSnapshot, BenchmarkSpendBudget } from
  "../apps/server/src/training/harness-refiner-benchmark-protocol.js";
import { runSequentialHarnessAdaptation } from
  "../apps/server/src/training/harness-refiner-benchmark-sequential-stage.js";

const NOW = "2026-08-11T17:00:00.000Z";

describe("sequential Harness adaptation", () => {
  test("gives each distinct task the Harness produced after the prior task", async () => {
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-sequential-test-"));
    let currentHash = "a".repeat(64);
    const backgroundSettings: boolean[] = [];
    const releasedHashes: string[] = [];
    const runtime = (hash: string) => ({
      workspace: {
        id: "workspace",
        currentChannel: {
          release: { id: `harness-${hash.slice(0, 8)}`, contentHash: hash },
        },
      },
      release: {
        harnessRelease: { id: `harness-${hash.slice(0, 8)}`, contentHash: hash },
        agentSnapshot: { id: `agent-${hash.slice(0, 8)}`, contentHash: hash },
      },
      instructionContext: `Harness ${hash}`,
    });
    const store = {
      setHarnessBackgroundReviewSettings: vi.fn(async ({ enabled }) => {
        backgroundSettings.push(enabled);
      }),
      getHarnessWorkspace: vi.fn(async () => ({
        id: "workspace",
        currentChannel: {
          release: { id: `harness-${currentHash.slice(0, 8)}`, contentHash: currentHash },
        },
      })),
      getHarnessReleaseRecord: vi.fn(async (hash: string) => ({
        harnessRelease: { id: `harness-${hash.slice(0, 8)}`, contentHash: hash },
        agentSnapshot: { id: `agent-${hash.slice(0, 8)}`, contentHash: hash },
      })),
      listHarnessImprovementArtifacts: vi.fn(async () => [{
        id: "outcome-1",
        contentHash: "e".repeat(64),
      }]),
    };
    let attemptOrdinal = 0;
    const execute = vi.fn(async (input: { taskId: string; releasedHarness: {
      harnessRelease: { contentHash: string };
    } }) => {
      releasedHashes.push(input.releasedHarness.harnessRelease.contentHash);
      const ordinal = attemptOrdinal++;
      const id = `attempt-${ordinal}`;
      return {
        attempt: {
          id,
          taskId: input.taskId,
          infrastructureError: null,
          costUsd: 0.01,
          latencyMs: 100,
          metadata: {
            usage: ordinal === 0
              ? { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
              : { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
        grade: { id: `grade-${id}`, passed: true },
        artifacts: [],
        portable: { receipt: { contentHash: "f".repeat(64) } },
      };
    });
    const runRefinerAfterAttempt = vi.fn(async ({ result }: {
      result: { attempt: { taskId: string } };
    }) => {
      if (result.attempt.taskId === "task-a") currentHash = "b".repeat(64);
      return {
        detection: {
          trigger: {
            id: `trigger-${result.attempt.taskId}`,
            contentHash: "c".repeat(64),
            decision: "queue_refiner",
          },
        },
        result: {
          outcome: {
            id: `outcome-${result.attempt.taskId}`,
            contentHash: "d".repeat(64),
            decision: result.attempt.taskId === "task-a" ? "proposed" : "no_action",
          },
        },
      };
    });

    const result = await runSequentialHarnessAdaptation({
      store: store as never,
      storeDir,
      evaluation: { execute } as never,
      modelRun: { id: "model-run" } as never,
      model: { providerId: "openpond", modelId: "openpond-chat" } as never,
      reasoningEffort: "high",
      taskset: { id: "taskset", tasks: [] } as never,
      taskIds: ["task-a", "task-b"],
      seed: 17,
      initialRuntime: runtime("a".repeat(64)) as never,
      evidenceSnapshot: new BenchmarkEvidenceSnapshot(),
      budget: new BenchmarkSpendBudget(1),
      admittedPricing: {} as never,
      refinerStream: async function* () {},
      signal: new AbortController().signal,
      now: () => NOW,
      onAttemptComplete: async () => undefined,
      adapters: {
        runRefinerAfterAttempt: runRefinerAfterAttempt as never,
        loadRuntimeFromRelease: (async ({ release }: { release: {
          harnessRelease: { contentHash: string };
        } }) => runtime(release.harnessRelease.contentHash)) as never,
        buildLineage: (async () => ({
          adaptationEvidenceHash: "1".repeat(64),
          refinerInputHash: "2".repeat(64),
          refinerOutcomeHash: "3".repeat(64),
          validationHash: "4".repeat(64),
          applyReceiptHash: "5".repeat(64),
          candidateRelease: { id: "harness-b", contentHash: "b".repeat(64) },
          valid: true,
        })) as never,
      },
    });

    expect(releasedHashes).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(backgroundSettings).toEqual([true, false]);
    expect(result.summary).toMatchObject({
      schemaVersion: "openpond.sequentialHarnessAdaptation.v1",
      attemptCount: 2,
      passedCount: 2,
      terminalCount: 2,
      initialHarness: { contentHash: "a".repeat(64) },
      finalHarness: { contentHash: "b".repeat(64) },
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      steps: [
        {
          taskId: "task-a",
          inputHarness: { contentHash: "a".repeat(64) },
          outputHarness: { contentHash: "b".repeat(64) },
          changed: true,
        },
        {
          taskId: "task-b",
          inputHarness: { contentHash: "b".repeat(64) },
          outputHarness: { contentHash: "b".repeat(64) },
          changed: false,
        },
      ],
    });
    await fs.rm(storeDir, { recursive: true, force: true });
  });
});
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
