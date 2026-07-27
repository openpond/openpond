import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildPrimeGrpoRemoteCommand,
  createPrimeGrpoBaseModelVersion,
  createPrimeGrpoFailureReceipt,
  downloadPrimeGrpoOutputArtifacts,
  estimatePrimeGrpoCostUsd,
  isPrimeNodeAlreadyTerminatedError,
  materializeVerifiedPrimeAdapterForImport,
  materializeRemotePythonProject,
  PRIME_GRPO_PYTHON_EXECUTABLE,
  readPrimeGrpoFailureUsage,
  readVerifiedGroupedReceipt,
  recentPrimeProvisioningFailureDevices,
} from "../apps/server/src/training/prime-grpo-model-run-service.ts";
import { createPrimeGrpoLearningSignalLineage } from "../apps/server/src/training/prime-grpo-harness.ts";
import { choosePrimeGrpoQuote } from "../apps/server/src/training/prime-grpo-plan.ts";
import { contentHash, sha256 } from "../packages/taskset-sdk/src/index.ts";

describe("Prime grouped-GRPO quote selection", () => {
  test("uses the wallet as the ceiling and chooses the least costly sufficient run", () => {
    const selected = choosePrimeGrpoQuote({
      devices: [
        { id: "h100-expensive", name: "H100 expensive" },
        { id: "h100-efficient", name: "H100 efficient" },
      ],
      hourlyQuotes: new Map([
        [
          "h100-expensive",
          {
            quoteId: "quote-expensive",
            hourlyCostUsd: 8,
          },
        ],
        [
          "h100-efficient",
          {
            quoteId: "quote-efficient",
            hourlyCostUsd: 4,
          },
        ],
      ]),
      walletBalanceUsd: 5,
      now: new Date("2026-07-25T12:00:00.000Z"),
    });

    expect(selected).toMatchObject({
      device: { id: "h100-efficient" },
      hourlyCostUsd: 4,
      estimatedCostUsd: 3,
      quoteId: "quote-efficient",
      durationMs: 45 * 60_000,
      deadline: "2026-07-25T12:45:00.000Z",
    });
  });

  test("fails before provisioning when the wallet cannot fund twenty minutes", () => {
    expect(() =>
      choosePrimeGrpoQuote({
        devices: [{ id: "h100", name: "H100" }],
        hourlyQuotes: new Map([
          [
            "h100",
            {
              quoteId: "quote",
              hourlyCostUsd: 6,
            },
          ],
        ]),
        walletBalanceUsd: 1.99,
        now: new Date("2026-07-25T12:00:00.000Z"),
      })
    ).toThrow("cannot cover the minimum 20-minute");
  });

  test("shortens the run instead of crossing the wallet ceiling", () => {
    const selected = choosePrimeGrpoQuote({
      devices: [{ id: "h100", name: "H100" }],
      hourlyQuotes: new Map([
        [
          "h100",
          {
            quoteId: "quote",
            hourlyCostUsd: 6,
          },
        ],
      ]),
      walletBalanceUsd: 3.5,
      now: new Date("2026-07-25T12:00:00.000Z"),
    });

    expect(selected.durationMs).toBe(35 * 60_000);
    expect(selected.estimatedCostUsd).toBeLessThanOrEqual(3.5);
  });

  test("prefers another affordable device after a recent SSH failure", () => {
    const selected = choosePrimeGrpoQuote({
      devices: [
        { id: "h100-cheapest", name: "H100 cheapest" },
        { id: "h100-alternate", name: "H100 alternate" },
      ],
      hourlyQuotes: new Map([
        [
          "h100-cheapest",
          {
            quoteId: "quote-cheapest",
            hourlyCostUsd: 3.29,
          },
        ],
        [
          "h100-alternate",
          {
            quoteId: "quote-alternate",
            hourlyCostUsd: 4.29,
          },
        ],
      ]),
      walletBalanceUsd: 2.15,
      now: new Date("2026-07-26T00:30:00.000Z"),
      targetDurationMs: 30 * 60_000,
      excludedDeviceIds: new Set(["h100-cheapest"]),
    });

    expect(selected.device.id).toBe("h100-alternate");
    expect(selected.estimatedCostUsd).toBe(2.145);
  });

  test("fails preflight when every affordable device is cooling down", () => {
    expect(() =>
      choosePrimeGrpoQuote({
        devices: [{ id: "h100-only", name: "H100 only" }],
        hourlyQuotes: new Map([
          [
            "h100-only",
            {
              quoteId: "quote-only",
              hourlyCostUsd: 3.29,
            },
          ],
        ]),
        walletBalanceUsd: 2.15,
        now: new Date("2026-07-26T00:30:00.000Z"),
        targetDurationMs: 30 * 60_000,
        excludedDeviceIds: new Set(["h100-only"]),
      })
    ).toThrow("failed provisioning within the retry cooldown");
  });
});

describe("Prime grouped-GRPO remote source bundle", () => {
  test("creates a separate immutable exact 8B base Model version zero", () => {
    const baseVersion = createPrimeGrpoBaseModelVersion({
      draft: {
        modelId: "model-marketing-8b",
        profileId: "profile-1",
        baseModel: {
          schemaVersion: "openpond.baseModelPreference.v1",
          modelId: "Qwen/Qwen3-8B",
          revision: "b968826d9c46dd6066d109eabc6255188de91218",
          tokenizerRevision: "b968826d9c46dd6066d109eabc6255188de91218",
          chatTemplateHash:
            "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
          modelAssetId: null,
          source: "managed",
        },
      } as never,
      taskset: {
        id: "taskset-marketing",
        profileId: "profile-1",
        revision: 1,
        contentHash: "1".repeat(64),
        profileRelease: {
          id: "profile-release-1",
          revision: 1,
          contentHash: "2".repeat(64),
        },
        environment: {
          actionBindings: [
            {
              agentRelease: {
                id: "agent-release-1",
                contentHash: "3".repeat(64),
              },
            },
          ],
        },
        graders: [
          {
            id: "marketing-portfolio-reward",
            kind: "state",
          },
        ],
      } as never,
      graph: {
        resolvedBundleManifest: {
          contentHash: "4".repeat(64),
        },
        manifest: {
          harnessRelease: {
            id: "harness-release-1",
            contentHash: "5".repeat(64),
          },
        },
      } as never,
      createdAt: "2026-07-26T00:00:00.000Z",
    });

    expect(baseVersion).toMatchObject({
      modelId: "model-marketing-8b",
      profileId: "profile-1",
      version: 0,
      kind: "base_reference",
      adapterStatus: "not_trained",
      artifactLineageId: null,
      baseModel: {
        modelId: "Qwen/Qwen3-8B",
        revision: "b968826d9c46dd6066d109eabc6255188de91218",
      },
      releaseGraph: {
        resolvedBundleHash: "4".repeat(64),
      },
    });
  });

  test("backs off recent and repeatedly failing Prime devices", () => {
    const job = (input: {
      id: string;
      status: "failed" | "succeeded" | "cancelled";
      completedAt: string;
      failureStage?: string;
      deviceOrPool: string;
      sshReadyAt?: string;
    }) =>
      ({
        id: input.id,
        status: input.status,
        completedAt: input.completedAt,
        metadata: {
          primeGrpo: true,
          failureStage: input.failureStage,
          deviceOrPool: input.deviceOrPool,
          sshReadyAt: input.sshReadyAt,
        },
      } as never);

    expect(
      recentPrimeProvisioningFailureDevices(
        [
          job({
            id: "recent-ssh",
            status: "failed",
            completedAt: "2026-07-26T00:16:00.000Z",
            failureStage: "provisioning_ssh",
            deviceOrPool: "h100-recent",
          }),
          job({
            id: "recent-capacity",
            status: "failed",
            completedAt: "2026-07-26T00:19:00.000Z",
            failureStage: "provisioning",
            deviceOrPool: "h100-capacity",
          }),
          job({
            id: "runtime-failure",
            status: "failed",
            completedAt: "2026-07-26T00:17:00.000Z",
            failureStage: "grouped_grpo",
            deviceOrPool: "h100-runtime",
          }),
          job({
            id: "old-ssh",
            status: "failed",
            completedAt: "2026-07-25T18:00:00.000Z",
            failureStage: "provisioning_ssh",
            deviceOrPool: "h100-old",
          }),
          job({
            id: "flaky-ssh-1",
            status: "failed",
            completedAt: "2026-07-25T22:00:00.000Z",
            failureStage: "provisioning_ssh",
            deviceOrPool: "h100-flaky",
          }),
          job({
            id: "flaky-ssh-2",
            status: "failed",
            completedAt: "2026-07-25T23:00:00.000Z",
            failureStage: "provisioning_ssh",
            deviceOrPool: "h100-flaky",
          }),
          job({
            id: "recovered-ssh-failure",
            status: "failed",
            completedAt: "2026-07-26T00:05:00.000Z",
            failureStage: "provisioning_ssh",
            deviceOrPool: "h100-recovered",
          }),
          job({
            id: "recovered-runtime",
            status: "cancelled",
            completedAt: "2026-07-26T00:20:00.000Z",
            deviceOrPool: "h100-recovered",
            sshReadyAt: "2026-07-26T00:10:00.000Z",
          }),
          job({
            id: "successful",
            status: "succeeded",
            completedAt: "2026-07-26T00:18:00.000Z",
            failureStage: "provisioning_ssh",
            deviceOrPool: "h100-success",
          }),
        ],
        new Date("2026-07-26T00:30:00.000Z")
      )
    ).toEqual(new Set(["h100-recent", "h100-capacity", "h100-flaky"]));
  });

  test("treats Prime timezone-less timestamps as UTC for spend evidence", () => {
    expect(
      estimatePrimeGrpoCostUsd({
        acquiredAt: "2026-07-25T22:35:02.667000",
        releasedAt: "2026-07-25T22:48:14.230Z",
        hourlyCostUsd: 4.29,
        maximumCostUsd: 2.145,
      })
    ).toBe(0.943279);
  });

  test("recovers completed rollout usage from failure artifacts", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-prime-grpo-usage-")
    );
    try {
      await mkdir(path.join(directory, "traces"), { recursive: true });
      await Promise.all([
        writeFile(
          path.join(directory, "grouped-grpo-state.json"),
          JSON.stringify({
            batchReceipts: [{ groupId: "group-1" }],
            optimizerReceipts: [],
          })
        ),
        writeFile(
          path.join(directory, "traces", "one.json"),
          JSON.stringify({
            result: {
              optimizerSample: {
                promptTokenCount: 120,
                completionTokenCount: 30,
              },
            },
          })
        ),
        writeFile(
          path.join(directory, "traces", "two.json"),
          JSON.stringify({
            result: {
              optimizerSample: {
                promptTokenCount: 80,
                completionTokenCount: 20,
              },
            },
          })
        ),
      ]);

      await expect(readPrimeGrpoFailureUsage(directory)).resolves.toEqual({
        promptTokens: 200,
        generatedTokens: 50,
        optimizerSteps: 0,
        rolloutGroups: 1,
        completedRollouts: 2,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("binds online signals to the exact Model identity in the run manifest", () => {
    const lineage = createPrimeGrpoLearningSignalLineage({
      plan: {
        recipe: {
          method: "grpo",
          reward: {
            graderHash: "6".repeat(64),
            toolContractHash: "7".repeat(64),
          },
        },
        manifest: {
          datasetRelease: {
            id: "dataset-1",
            contentHash: "1".repeat(64),
          },
          harnessRelease: {
            id: "harness-1",
            contentHash: "2".repeat(64),
          },
          evidenceSets: [
            {
              id: "evidence-1",
              contentHash: "3".repeat(64),
            },
          ],
          model: {
            source: "Qwen/Qwen3-0.6B",
            revision: "4".repeat(64),
            artifactHash: null,
          },
        },
      } as never,
      taskset: {
        profileRelease: {
          id: "profile-1",
          revision: 1,
          contentHash: "5".repeat(64),
        },
        environment: { kind: "agent" },
      } as never,
      verificationReceiptHash: "8".repeat(64),
    });

    expect(lineage.model).toEqual({
      source: "Qwen/Qwen3-0.6B",
      revision: "4".repeat(64),
      artifactHash: null,
    });
    expect(lineage.evidenceSetRelease).toEqual({
      id: "evidence-1",
      contentHash: "3".repeat(64),
    });
  });

  test("content-addresses bounded failure and cleanup evidence", () => {
    const receipt = createPrimeGrpoFailureReceipt({
      modelRunId: "model-run-1",
      jobId: "job-1",
      stage: "grouped_grpo",
      error: "remote verifier rejected the plan",
      planHash: "1".repeat(64),
      manifestHash: "2".repeat(64),
      bundleHash: "3".repeat(64),
      model: {
        id: "Qwen/Qwen3-0.6B",
        revision: "c1899de289a04d12100db370d81485cdf75e47ca",
      },
      quote: {
        device: { id: "h100", name: "H100" },
        hourlyCostUsd: 4.29,
        estimatedCostUsd: 2.145,
        quoteId: "quote-1",
        deadline: "2026-07-25T12:30:00.000Z",
        durationMs: 1_800_000,
      },
      providerResource: {
        resourceId: "node-1",
        acquiredAt: "2026-07-25T12:00:00.000Z",
      },
      usage: {
        promptTokens: 0,
        generatedTokens: 0,
        optimizerSteps: 0,
        rolloutGroups: 0,
      },
      cost: {
        providerReportedUsd: null,
        estimatedUsd: 0.1,
        methodology:
          "provider_acquired_elapsed_hours_times_locked_hourly_quote_capped_at_quote",
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
      schemaVersion: "openpond.primeGrpoFailureReceipt.v1",
      stage: "grouped_grpo",
      cleanup: {
        remoteStopped: true,
        tunnelClosed: true,
        computeReleased: true,
      },
    });
    expect(actual).toBe(contentHash(core));
  });

  test("launches with the Python executable shipped by Prime images", () => {
    const command = buildPrimeGrpoRemoteCommand({
      remoteDirectory: "/tmp/run",
      remoteProject: "/tmp/run/openpond-training",
    });

    expect(PRIME_GRPO_PYTHON_EXECUTABLE).toBe("python");
    expect(command).toContain("python");
    expect(command).not.toContain("python3");
    expect(command).toContain("openpond_training.prime_grpo_runner");
  });

  test("reconciles from the canonical receipt file instead of mixed remote stdout", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-prime-grpo-receipt-")
    );
    try {
      const receiptPath = path.join(directory, "grouped-grpo-receipt.json");
      const manifestId = "manifest-model-run-1";
      const manifestHash = "1".repeat(64);
      const core = {
        schemaVersion: "openpond.groupedGrpoCoordinatorReceipt.v1",
        runId: manifestId,
        manifestId,
        manifestHash,
        optimizerSteps: 1,
        finalPolicyVersion: 1,
        batchReceipts: [{ batchHash: "2".repeat(64) }],
        optimizerReceipts: [{ contentHash: "3".repeat(64) }],
        reloadReceipts: [{ contentHash: "4".repeat(64) }],
        timeline: [],
        completedAt: "2026-07-26T03:13:45.138Z",
      };
      await writeFile(
        receiptPath,
        JSON.stringify({
          ...core,
          contentHash: contentHash(core),
        })
      );

      await expect(
        readVerifiedGroupedReceipt(receiptPath, {
          manifest: {
            id: manifestId,
            contentHash: manifestHash,
          },
          recipe: {
            method: "grpo",
            optimizer: { maxSteps: 1 },
          },
        } as never)
      ).resolves.toMatchObject({
        optimizerSteps: 1,
        finalPolicyVersion: 1,
        contentHash: contentHash(core),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("downloads only the adapter and optimizer receipt from the remote output", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-prime-grpo-output-")
    );
    const downloads: Array<{ remotePath: string; localDirectory: string }> = [];
    try {
      await downloadPrimeGrpoOutputArtifacts({
        remoteDirectory: "/tmp/run",
        artifactRoot: directory,
        transport: {
          async download(remotePath, localDirectory) {
            downloads.push({ remotePath, localDirectory });
          },
        },
      });

      expect(downloads).toEqual([
        {
          remotePath: "/tmp/run/output/adapter/adapter_config.json",
          localDirectory: path.join(directory, "output", "adapter"),
        },
        {
          remotePath: "/tmp/run/output/adapter/adapter_model.safetensors",
          localDirectory: path.join(directory, "output", "adapter"),
        },
        {
          remotePath: "/tmp/run/output/prime-rl-step-receipts.jsonl",
          localDirectory: path.join(directory, "output"),
        },
      ]);
      expect(
        downloads.some(({ remotePath }) => remotePath.includes("checkpoints"))
      ).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("recovers the canonical adapter from a receipt-verified Prime-RL optimizer output", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-prime-grpo-recovery-")
    );
    const config = Buffer.from('{"r":16}');
    const weights = Buffer.from("trained-lora-weights");
    const recoveryDirectory = path.join(
      directory,
      ".prime-rl",
      "output",
      "weights",
      "step_1",
      "lora_adapters"
    );
    try {
      await mkdir(recoveryDirectory, { recursive: true });
      await Promise.all([
        writeFile(path.join(recoveryDirectory, "adapter_config.json"), config),
        writeFile(
          path.join(recoveryDirectory, "adapter_model.safetensors"),
          weights
        ),
      ]);

      const result = await materializeVerifiedPrimeAdapterForImport(directory, {
        finalPolicyVersion: 1,
        optimizerReceipts: [
          {
            adapter: {
              configSha256: sha256(config),
              weightsSha256: sha256(weights),
            },
          },
        ],
      });

      expect(result).toEqual({ recoveredFrom: recoveryDirectory });
      await expect(
        readFile(path.join(directory, "adapter", "adapter_config.json"))
      ).resolves.toEqual(config);
      await expect(
        readFile(path.join(directory, "adapter", "adapter_model.safetensors"))
      ).resolves.toEqual(weights);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("treats an already-absent Prime node as an idempotent cleanup", () => {
    expect(
      isPrimeNodeAlreadyTerminatedError(
        new Error("Prime API DELETE /api/v1/pods/node failed (404): not found")
      )
    ).toBe(true);
    expect(
      isPrimeNodeAlreadyTerminatedError(
        new Error("Prime API DELETE /api/v1/pods/node failed (500): broken")
      )
    ).toBe(false);
  });

  test("copies only the locked project definition and runtime source", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-prime-grpo-")
    );
    try {
      const sourceDirectory = path.join(directory, "source");
      const artifactRoot = path.join(directory, "artifacts");
      await Promise.all([
        mkdir(path.join(sourceDirectory, "src", "package"), {
          recursive: true,
        }),
        mkdir(path.join(sourceDirectory, ".venv", "bin"), {
          recursive: true,
        }),
        mkdir(path.join(sourceDirectory, "tests"), {
          recursive: true,
        }),
      ]);
      await Promise.all([
        writeFile(
          path.join(sourceDirectory, "pyproject.toml"),
          "[project]\nname='openpond-training'\n"
        ),
        writeFile(path.join(sourceDirectory, "uv.lock"), "locked"),
        writeFile(
          path.join(sourceDirectory, "src", "package", "runner.py"),
          "RUNNER = True\n"
        ),
        writeFile(
          path.join(sourceDirectory, ".venv", "bin", "python"),
          "large local environment"
        ),
        writeFile(
          path.join(sourceDirectory, "tests", "test_runner.py"),
          "not needed remotely"
        ),
      ]);

      const result = await materializeRemotePythonProject({
        sourceDirectory,
        artifactRoot,
      });

      expect(
        await readFile(path.join(result, "pyproject.toml"), "utf8")
      ).toContain("openpond-training");
      expect(
        await readFile(path.join(result, "src", "package", "runner.py"), "utf8")
      ).toContain("RUNNER");
      await expect(
        readFile(path.join(result, ".venv", "bin", "python"))
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(path.join(result, "tests", "test_runner.py"))
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
