import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createPrimeEvaluationFailureReceipt,
  parsePrimeEvaluationCompletion,
  PRIME_EVALUATION_PYTHON_EXECUTABLE,
  waitForPrimeEvaluationInventory,
} from "../apps/server/src/training/prime-evaluation-session.ts";
import { contentHash } from "../packages/taskset-sdk/src/index.ts";

describe("raw-Prime evaluation completion boundary", () => {
  test("uses the Python executable shipped by the Prime-RL image", () => {
    expect(PRIME_EVALUATION_PYTHON_EXECUTABLE).toBe("python");
  });

  test("accepts a model-aligned tool completion with usage facts", () => {
    expect(
      parsePrimeEvaluationCompletion(
        {
          model: "Qwen/Qwen3-0.6B",
          choices: [{
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: {
                  name: "get_portfolio_snapshot",
                  arguments: "{\"portfolio_id\":\"p1\"}",
                },
              }],
            },
          }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
          },
        },
        "Qwen/Qwen3-0.6B",
      ),
    ).toMatchObject({
      responseModel: "Qwen/Qwen3-0.6B",
      finishReason: "tool_calls",
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      toolCalls: [{
        id: "call-1",
        function: {
          name: "get_portfolio_snapshot",
          arguments: "{\"portfolio_id\":\"p1\"}",
        },
      }],
    });
  });

  test("rejects a response from a different served policy", () => {
    expect(() =>
      parsePrimeEvaluationCompletion(
        {
          model: "Qwen/Qwen3-0.6B",
          choices: [{
            finish_reason: "stop",
            message: { content: "text", tool_calls: [] },
          }],
        },
        "openpond-policy-v1",
      )
    ).toThrow("instead of openpond-policy-v1");
  });

  test("content-addresses failure stage, usage, cost, and cleanup facts", () => {
    const receipt = createPrimeEvaluationFailureReceipt({
      sessionId: "prime_eval_failure",
      purpose: "train-signal",
      stage: "vllm_readiness",
      error: "readiness timeout",
      model: {
        repository: "Qwen/Qwen3-0.6B",
        revision: "c1899de289a04d12100db370d81485cdf75e47ca",
      },
      adapter: null,
      wallet: { balanceUsd: 5 },
      quote: { quoteId: "quote-1", estimatedCostUsd: 2 },
      provisionAttempts: [],
      providerResource: { nodeId: "node-1" },
      requests: [],
      usage: { requests: 0 },
      cost: {
        providerReportedUsd: null,
        estimatedUsd: 0.25,
        methodology:
          "elapsed_hours_times_locked_hourly_quote_capped_at_quote",
        methodologyVersion: "1",
      },
      cleanup: {
        remoteStopped: true,
        tunnelClosed: true,
        computeReleased: true,
        startedAt: "2026-07-25T12:01:00.000Z",
        completedAt: "2026-07-25T12:01:01.000Z",
      },
      startedAt: "2026-07-25T12:00:00.000Z",
      completedAt: "2026-07-25T12:01:01.000Z",
    });
    const { contentHash: actual, ...core } = receipt;

    expect(receipt).toMatchObject({
      schemaVersion:
        "openpond.primeEvaluationSessionFailureReceipt.v1",
      stage: "vllm_readiness",
      error: "readiness timeout",
      cleanup: {
        remoteStopped: true,
        tunnelClosed: true,
        computeReleased: true,
      },
    });
    expect(actual).toBe(contentHash(core));
  });

  test("waits for bounded H100 availability and records every check", async () => {
    const artifactRoot = await mkdtemp(
      path.join(tmpdir(), "openpond-prime-inventory-"),
    );
    const inventories = [
      {
        devices: [],
        capabilityReceipt: "empty-receipt",
        checkedAt: "2026-07-25T12:00:00.000Z",
      },
      {
        devices: [{
          id: "h100-offer",
          kind: "gpu" as const,
          vendor: "nvidia" as const,
          name: "H100 80 GB",
          memoryBytes: 80_000_000_000,
          runtime: "cuda" as const,
        }],
        capabilityReceipt: "available-receipt",
        checkedAt: "2026-07-25T12:00:15.000Z",
      },
    ];
    const waits: number[] = [];
    const inventory = await waitForPrimeEvaluationInventory({
      inventory: async () => inventories.shift()!,
      artifactRoot,
      waitMs: 30_000,
      pollIntervalMs: 15_000,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    expect(inventory.devices).toHaveLength(1);
    expect(waits).toEqual([15_000]);
    const receipt = JSON.parse(
      await readFile(
        path.join(artifactRoot, "inventory-attempts.json"),
        "utf8",
      ),
    );
    expect(receipt).toMatchObject({
      schemaVersion:
        "openpond.primeEvaluationInventoryAttempts.v1",
      policy: {
        waitMs: 30_000,
        pollIntervalMs: 15_000,
      },
      attempts: [
        {
          attempt: 1,
          status: "empty",
          deviceCount: 0,
        },
        {
          attempt: 2,
          status: "available",
          deviceCount: 1,
        },
      ],
    });
    expect(receipt.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("fails explicitly after bounded empty inventory checks", async () => {
    const artifactRoot = await mkdtemp(
      path.join(tmpdir(), "openpond-prime-inventory-"),
    );
    await expect(
      waitForPrimeEvaluationInventory({
        inventory: async () => ({
          devices: [],
          capabilityReceipt: "empty-receipt",
          checkedAt: "2026-07-25T12:00:00.000Z",
        }),
        artifactRoot,
        waitMs: 30_000,
        pollIntervalMs: 15_000,
        wait: async () => undefined,
      }),
    ).rejects.toThrow(
      "remained unavailable after 3 checks over up to 30 seconds; no H100 was provisioned",
    );
  });
});
