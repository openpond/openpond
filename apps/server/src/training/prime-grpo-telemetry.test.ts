import { describe, expect, test } from "vitest";

import { contentHash } from "@openpond/taskset-sdk";

import { buildPrimeGrpoTelemetryReceipt } from "./prime-grpo-telemetry.js";

const HASH = "a".repeat(64);

describe("Prime GRPO correlated telemetry", () => {
  test("binds raw spans, usage, exact identity, and labeled estimates", () => {
    const receipt = buildPrimeGrpoTelemetryReceipt({
      modelRunId: "model_run_1",
      modelVersionId: "model_version_1",
      groupedReceipt: {
        optimizerSteps: 1,
        finalPolicyVersion: 1,
        batchReceipts: [{ groupId: "group-1" }],
        timeline: [span("rollout_group", "2026-07-25T12:00:20.000Z", 10_000)],
        optimizerReceipts: [
          {
            adapter: { weightsSha256: HASH },
            spans: [
              span("checkpoint_writing", "2026-07-25T12:00:40.000Z", 5_000),
            ],
          },
        ],
      },
      traceReceipts: [
        {
          result: {
            status: "succeeded",
            terminal: true,
            optimizerSample: {
              promptTokenCount: 100,
              completionTokenCount: 20,
            },
            executionSpans: [
              span("generation", "2026-07-25T12:00:20.000Z", 4_000),
              span("grading", "2026-07-25T12:00:24.000Z", 1_000),
            ],
          },
        },
      ],
      lifecycleSpans: [
        span("remote_execution", "2026-07-25T12:00:10.000Z", 50_000, "wall"),
      ],
      provider: {
        resourceId: "pod-1",
        gpuType: "H100 80GB",
        gpuCount: 1,
        acquiredAt: "2026-07-25T12:00:00.000Z",
        releasedAt: "2026-07-25T12:01:00.000Z",
        providerReportedUsd: null,
        quotedHourlyUsd: 3.6,
      },
      base: {
        profileId: "qwen3-0-6b-c1899de2",
        repository: "Qwen/Qwen3-0.6B",
        revision: "c1899de289a04d12100db370d81485cdf75e47ca",
      },
      recordedAt: "2026-07-25T12:01:01.000Z",
    });

    expect(receipt.usage).toEqual({
      promptTokens: 100,
      generatedTokens: 20,
      gpuSeconds: 60,
      workerActiveSeconds: 50,
      optimizerSteps: 1,
      rolloutGroups: 1,
      successfulTrajectories: 1,
      failedTrajectories: 0,
      peakGpuMemoryBytes: null,
      peakGpuUtilizationPercent: null,
    });
    expect(receipt.resource).toMatchObject({
      provider: "prime",
      resourceIds: ["pod-1"],
      gpuType: "H100 80GB",
      gpuCount: 1,
      baseProfileId: "qwen3-0-6b-c1899de2",
      adapterContentHash: HASH,
    });
    expect(receipt.cost).toMatchObject({
      providerReportedUsd: null,
      estimatedUsd: 0.06,
      methodologyVersion: "openpond.primeRawWallClockEstimate.v1",
      unitEstimates: {
        perRolloutUsd: 0.06,
        perOptimizerStepUsd: 0.06,
        perAcceptedModelUsd: 0.06,
      },
    });
    const { contentHash: actual, ...core } = receipt;
    expect(actual).toBe(contentHash(core));
  });

  test("rejects an invalid provider billing window", () => {
    expect(() =>
      buildPrimeGrpoTelemetryReceipt({
        modelRunId: "model_run_1",
        modelVersionId: "model_version_1",
        groupedReceipt: {
          optimizerSteps: 0,
          finalPolicyVersion: 0,
        },
        traceReceipts: [],
        lifecycleSpans: [],
        provider: {
          resourceId: "pod-1",
          gpuType: "H100",
          gpuCount: 1,
          acquiredAt: "2026-07-25T12:01:00.000Z",
          releasedAt: "2026-07-25T12:00:00.000Z",
          providerReportedUsd: null,
          quotedHourlyUsd: 3.6,
        },
        base: {
          profileId: "qwen3-0-6b-c1899de2",
          repository: "Qwen/Qwen3-0.6B",
          revision: "c1899de289a04d12100db370d81485cdf75e47ca",
        },
        recordedAt: "2026-07-25T12:01:01.000Z",
      })
    ).toThrow("prime_grpo_telemetry_provider_window_invalid");
  });
});

function span(
  name: string,
  startedAt: string,
  durationMs: number,
  clock: "monotonic" | "provider" | "wall" = "monotonic"
) {
  return {
    name,
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(),
    durationMs,
    clock,
    outcome: "succeeded" as const,
  };
}
