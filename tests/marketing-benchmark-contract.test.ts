import {
  CorrelatedTelemetryReceiptSchema,
  MarketingBenchmarkSpecificationSchema,
  type BaselineReport,
  type ModelVersion,
  type TaskAttemptResult,
  type Taskset,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import type { SqliteStore } from "../apps/server/src/store/store.ts";
import { SqliteTrainingStore } from "../apps/server/src/store/store-training.ts";
import { TRAINING_TABLES_SQL } from "../apps/server/src/store/store-training-base-schema.ts";
import {
  createMarketingBenchmarkSpecification,
  MARKETING_BENCHMARK_FRONTIER_MODEL,
} from "../apps/server/src/training/marketing-benchmark.ts";
import {
  MARKETING_PORTFOLIO_HARNESS_CONTRACT_HASH,
} from "../apps/server/src/training/marketing-portfolio-constraint-repair.ts";
import {
  allocatePrimeEvaluationCost,
  buildMarketingBenchmarkReceipt,
  successfulMarketingBenchmarkTrajectory,
} from "../apps/server/src/training/marketing-benchmark-results.ts";
import {
  marketingBenchmarkEvaluationOutcomeMetadata,
} from "../apps/server/src/training/marketing-benchmark-run-service.ts";
import { runTrainingTasksetAttempt } from "../apps/server/src/training/task-baseline-attempt-runner.ts";

describe("marketing three-arm benchmark contract", () => {
  test("preregisters eight frozen tasks, four attempts, three arms, and promotion gates", () => {
    const taskset = tasksetFixture();
    const specification = createMarketingBenchmarkSpecification({
      taskset,
      baseVersion: baseVersionFixture(taskset),
      baselineReport: baselineReportFixture(taskset),
      minimumCandidateScore: 0.75,
      minimumImprovement: 0.05,
      authoringModel: MARKETING_BENCHMARK_FRONTIER_MODEL,
      createdAt: "2026-07-25T12:00:00.000Z",
    });

    expect(MarketingBenchmarkSpecificationSchema.parse(specification)).toEqual(
      specification,
    );
    expect(specification.frozenTaskIds).toHaveLength(8);
    expect(specification.attemptSchedule).toHaveLength(32);
    expect(new Set(
      specification.attemptSchedule.map(
        (entry) => `${entry.taskId}:${entry.attempt}`,
      ),
    ).size).toBe(32);
    expect(specification.arms.map((arm) => arm.arm)).toEqual([
      "base",
      "candidate",
      "frontier_reference",
    ]);
    expect(specification.promotionGate).toMatchObject({
      minimumCandidateScore: 0.75,
      minimumImprovement: 0.05,
      frontierComparisonBlocksPromotion: false,
    });
  });

  test("rejects a schedule that reuses one frozen task", () => {
    const taskset = tasksetFixture();
    taskset.tasks[7] = {
      ...taskset.tasks[7]!,
      id: taskset.tasks[0]!.id,
    };
    expect(() =>
      createMarketingBenchmarkSpecification({
        taskset,
        baseVersion: baseVersionFixture(taskset),
        baselineReport: baselineReportFixture(taskset),
        minimumCandidateScore: 0.75,
        minimumImprovement: 0.05,
        authoringModel: null,
      }),
    ).toThrow("immutable 8-task");
  });

  test("preregisters a distinct exact 8B base when its signal matches", () => {
    const taskset = tasksetFixture();
    const baseVersion = {
      ...baseVersionFixture(taskset),
      id: "model-version-8b-0",
      modelId: "model-marketing-8b",
      baseModel: {
        ...baseVersionFixture(taskset).baseModel,
        modelId: "Qwen/Qwen3-8B",
        revision:
          "b968826d9c46dd6066d109eabc6255188de91218",
        tokenizerRevision:
          "b968826d9c46dd6066d109eabc6255188de91218",
        chatTemplateHash:
          "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
      },
    } as ModelVersion;
    const baselineReport = baselineReportFixture(taskset);
    baselineReport.scope!.model.modelId = "Qwen/Qwen3-8B";

    const specification = createMarketingBenchmarkSpecification({
      taskset,
      baseVersion,
      baselineReport,
      minimumCandidateScore: 0.85,
      minimumImprovement: 0.02,
      authoringModel: null,
    });

    expect(specification.arms[0]).toMatchObject({
      modelProjectId: "model-marketing-8b",
      modelVersionId: "model-version-8b-0",
      baseRepository: "Qwen/Qwen3-8B",
      baseRevision:
        "b968826d9c46dd6066d109eabc6255188de91218",
    });
    const candidate = {
      ...baseVersion,
      id: "model-version-8b-1",
      version: 1,
      kind: "lora_adapter",
      artifactLineageId: "lineage-8b-1",
      adapterStatus: "trained",
    } as ModelVersion;
    const schedule = specification.attemptSchedule[0]!;
    const trajectory = successfulMarketingBenchmarkTrajectory({
      arm: "candidate",
      schedule,
      attempt: successfulAttemptFixture({
        taskset,
        arm: "candidate",
        schedule,
        reward: 0.9,
      }),
      specification,
      candidate,
      adapterContentHash: sha256("adapter-8b"),
      provider: "prime",
      providerResourceIds: ["prime-node-8b"],
    });
    expect(trajectory.telemetry.resource).toMatchObject({
      baseProfileId: "qwen3-8b-b968826d",
      baseRepository: "Qwen/Qwen3-8B",
      baseRevision:
        "b968826d9c46dd6066d109eabc6255188de91218",
    });
  });

  test("retains a response with an invalid tool loop as an explicit policy failure", () => {
    const taskset = tasksetFixture();
    const baseVersion = baseVersionFixture(taskset);
    const specification = createMarketingBenchmarkSpecification({
      taskset,
      baseVersion,
      baselineReport: baselineReportFixture(taskset),
      minimumCandidateScore: 0.75,
      minimumImprovement: 0.05,
      authoringModel: MARKETING_BENCHMARK_FRONTIER_MODEL,
      createdAt: "2026-07-25T12:00:00.000Z",
    });
    const candidate = {
      ...baseVersion,
      id: "model-version-policy-failure-1",
      version: 1,
      kind: "lora_adapter",
      artifactLineageId: "lineage-policy-failure-1",
      adapterStatus: "trained",
    } as ModelVersion;
    const schedule = specification.attemptSchedule[0]!;
    const attempt = successfulAttemptFixture({
      taskset,
      arm: "base",
      schedule,
      reward: 0.25,
    });
    attempt.output = {
      ...attempt.output,
      toolSequence: ["get_portfolio_snapshot"],
      terminalDecision: false,
    };

    const trajectory = successfulMarketingBenchmarkTrajectory({
      arm: "base",
      schedule,
      attempt,
      specification,
      candidate,
      adapterContentHash: sha256("adapter-policy-failure"),
      provider: "prime",
      providerResourceIds: ["prime-node-a10"],
      providerGpuType: "A10_24GB",
    });

    expect(trajectory).toMatchObject({
      reward: 0,
      passed: false,
      failureClass: "invalid_two_action_tool_loop",
      toolSequence: ["get_portfolio_snapshot"],
      terminalDecision: false,
      constraintViolations: ["valid_two_action_completion"],
      telemetry: {
        resource: {
          gpuType: "A10_24GB",
        },
        usage: {
          successfulTrajectories: 0,
          failedTrajectories: 1,
        },
      },
    });
    expect(trajectory.providerResponseIdentity).toContain(
      "custom-openai-compatible",
    );
  });

  test("publishes the canonical binding-gate fields on the frozen evaluation artifact", () => {
    expect(
      marketingBenchmarkEvaluationOutcomeMetadata(true),
    ).toEqual({
      promotionPassed: true,
      evaluationComplete: true,
      thresholdPassed: true,
    });
    expect(
      marketingBenchmarkEvaluationOutcomeMetadata(false),
    ).toEqual({
      promotionPassed: false,
      evaluationComplete: true,
      thresholdPassed: false,
    });
  });

  test("keeps provider cost facts separate from labeled estimates", () => {
    const core = {
      schemaVersion: "openpond.correlatedTelemetryReceipt.v1" as const,
      stage: "training" as const,
      correlation: {
        modelRunId: "run-1",
        modelVersionId: "version-0",
        policyVersion: 0,
        taskId: "task-1",
        rolloutGroupId: "group-1",
        providerResourceId: "node-1",
        deploymentId: null,
        inferenceRequestId: "request-1",
      },
      spans: [{
        name: "generation",
        startedAt: "2026-07-25T12:00:00.000Z",
        completedAt: "2026-07-25T12:00:01.000Z",
        durationMs: 1_000,
        clock: "monotonic" as const,
        outcome: "succeeded" as const,
      }],
      usage: {
        promptTokens: 100,
        generatedTokens: 20,
        gpuSeconds: 1,
        workerActiveSeconds: 1,
        optimizerSteps: 0,
        rolloutGroups: 1,
        successfulTrajectories: 1,
        failedTrajectories: 0,
        peakGpuMemoryBytes: null,
        peakGpuUtilizationPercent: null,
      },
      resource: {
        provider: "prime",
        resourceIds: ["node-1"],
        gpuType: "H100",
        gpuCount: 1,
        baseProfileId: "qwen3-0-6b-c1899de2",
        baseRepository: "Qwen/Qwen3-0.6B",
        baseRevision: "c1899de289a04d12100db370d81485cdf75e47ca",
        adapterContentHash: null,
      },
      cost: {
        currency: "USD" as const,
        providerReportedUsd: 0.42,
        quotedHourlyUsd: 2.5,
        estimatedUsd: 0.001,
        methodologyVersion: "openpond.cost.v1",
        pricingInputs: { hourlyUsd: 2.5, wallSeconds: 1 },
        unitEstimates: { perRolloutUsd: 0.001 },
      },
      recordedAt: "2026-07-25T12:00:01.000Z",
    };
    const receipt = CorrelatedTelemetryReceiptSchema.parse({
      ...core,
      contentHash: contentHash(core),
    });
    expect(receipt.cost.providerReportedUsd).toBe(0.42);
    expect(receipt.cost.estimatedUsd).toBe(0.001);
    expect(receipt.cost.methodologyVersion).toBe("openpond.cost.v1");
  });

  test("persists the immutable preregistration and scopes reads by Profile", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openpond-benchmark-store-"));
    const store = new SqliteTrainingStore(directory);
    const taskset = tasksetFixture();
    const specification = createMarketingBenchmarkSpecification({
      taskset,
      baseVersion: baseVersionFixture(taskset),
      baselineReport: baselineReportFixture(taskset),
      minimumCandidateScore: 0.75,
      minimumImprovement: 0.05,
      authoringModel: null,
      createdAt: "2026-07-25T12:00:00.000Z",
    });
    try {
      const writableStore = store as unknown as {
        ready: Promise<void>;
        exec(sql: string): Promise<void>;
      };
      await writableStore.ready;
      await writableStore.exec(
        TRAINING_TABLES_SQL,
      );
      await store.saveMarketingBenchmarkSpecification(specification);
      await expect(
        store.listMarketingBenchmarkSpecifications({
          profileId: taskset.profileId,
        }),
      ).resolves.toEqual([specification]);
      await expect(
        store.listMarketingBenchmarkSpecifications({
          profileId: "different-profile",
        }),
      ).resolves.toEqual([]);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("routes frozen marketing attempts through the two-action Harness instead of text completion", async () => {
    const taskset = tasksetFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "openpond-marketing-"));
    const savedArtifacts: unknown[] = [];
    const store = {
      getTaskset: async () => taskset,
      saveTaskAttemptArtifact: async (artifact: unknown) => {
        savedArtifacts.push(artifact);
        return artifact;
      },
    } as unknown as SqliteStore;
    let streamTurn = 0;
    try {
      const result = await runTrainingTasksetAttempt({
        store,
        storeDir: directory,
        resultId: "attempt-marketing-frozen",
        modelText: async () => {
          throw new Error("Text completion must not run.");
        },
        crossSystemStream: async function* () {
          streamTurn += 1;
          yield {
            toolCalls: [{
              index: 0,
              id: `call-${streamTurn}`,
              type: "function",
              function: {
                name: streamTurn === 1
                  ? "get_portfolio_snapshot"
                  : "submit_budget_decision",
                arguments: streamTurn === 1
                  ? "{}"
                  : JSON.stringify({
                      allocations: [
                        { channelId: "search", amountUsd: 25_000 },
                        { channelId: "social", amountUsd: 25_000 },
                        { channelId: "video", amountUsd: 25_000 },
                        { channelId: "lifecycle", amountUsd: 25_000 },
                      ],
                      rationale: "Use the observed portfolio evidence.",
                      riskControls: ["brand_safety"],
                    }),
              },
            }],
          };
        },
        createMarketingRuntime: async () => ({
          executeAction: async ({ binding }) => ({
            output: binding.actionId === "get-portfolio-snapshot"
              ? { incrementalBudgetUsd: 100_000 }
              : { accepted: true },
            terminal: binding.actionId === "submit-budget-decision",
            artifactRefs: [],
          }),
          scoreDecision: async () => ({
            reward: 0.8,
            components: {
              constraints: 1,
              portfolioValue: 0.8,
              riskControls: 0.7,
              rationale: 0.7,
            },
            validation: { accepted: true },
          }),
        }),
        attemptInput: {
          tasksetId: taskset.id,
          task: taskset.tasks[0]!,
          model: MARKETING_BENCHMARK_FRONTIER_MODEL,
          seed: 25_000,
          attempt: 0,
        },
      });

      expect(result.metadata).toMatchObject({
        execution: "marketing_portfolio_tool_loop",
        validToolTrace: true,
        policyFailure: null,
      });
      expect(result.output).toMatchObject({
        toolSequence: [
          "get_portfolio_snapshot",
          "submit_budget_decision",
        ],
        terminalDecision: true,
      });
      expect(savedArtifacts).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("builds the paired 96-trajectory receipt and applies preregistered promotion gates", () => {
    const taskset = tasksetFixture();
    const specification =
      createMarketingBenchmarkSpecification({
        taskset,
        baseVersion: baseVersionFixture(taskset),
        baselineReport: baselineReportFixture(taskset),
        minimumCandidateScore: 0.75,
        minimumImprovement: 0.05,
        authoringModel:
          MARKETING_BENCHMARK_FRONTIER_MODEL,
        createdAt: "2026-07-25T12:00:00.000Z",
      });
    const candidate = {
      ...baseVersionFixture(taskset),
      id: "model-version-1",
      version: 1,
      kind: "lora_adapter",
      artifactLineageId: "lineage-1",
      adapterStatus: "trained",
    } as unknown as ModelVersion;
    const rewards = {
      base: 0.6,
      candidate: 0.8,
      frontier_reference: 0.7,
    } as const;
    const trajectories = (
      ["base", "candidate", "frontier_reference"] as const
    ).flatMap((arm) =>
      specification.attemptSchedule.map((schedule) => {
        const attempt = successfulAttemptFixture({
          taskset,
          arm,
          schedule,
          reward: rewards[arm],
        });
        return successfulMarketingBenchmarkTrajectory({
          arm,
          schedule,
          attempt,
          specification,
          candidate,
          adapterContentHash: sha256("adapter"),
          provider:
            arm === "frontier_reference"
              ? "openai"
              : "prime",
          providerResourceIds:
            arm === "frontier_reference"
              ? []
              : ["prime-node-1"],
        });
      }),
    );
    const costed = allocatePrimeEvaluationCost(
      trajectories,
      0.64,
    );
    const receipt = buildMarketingBenchmarkReceipt({
      id: "marketing-benchmark-receipt-1",
      specification,
      candidate,
      trajectories: costed,
      createdAt: "2026-07-25T13:00:00.000Z",
    });

    expect(receipt.trajectories).toHaveLength(96);
    expect(receipt.aggregate).toMatchObject({
      base: { meanReward: 0.6 },
      candidate: { meanReward: 0.8 },
      frontier_reference: { meanReward: 0.7 },
    });
    expect(receipt.pairedComparison).toMatchObject({
      candidateMinusBase: 0.2,
      candidateMinusFrontier: 0.1,
      candidatePromotionPassed: true,
      frontierWinnerClaimPassed: true,
    });
    expect(
      (receipt.aggregate.base.costUsd ?? 0)
      + (receipt.aggregate.candidate.costUsd ?? 0),
    ).toBeCloseTo(0.64, 6);
    expect(receipt.disclosure).toContain(
      "eight paired unique-task",
    );
  });
});

function successfulAttemptFixture(input: {
  taskset: Taskset;
  arm: "base" | "candidate" | "frontier_reference";
  schedule: {
    taskId: string;
    attempt: number;
    seed: number;
  };
  reward: number;
}): TaskAttemptResult {
  const provider =
    input.arm === "frontier_reference"
      ? "openai"
      : "custom-openai-compatible";
  return {
    schemaVersion: "openpond.taskAttempt.v1",
    id:
      `attempt-${input.arm}-${input.schedule.taskId}-${input.schedule.attempt}`,
    tasksetId: input.taskset.id,
    taskId: input.schedule.taskId,
    split: "frozen_eval",
    attempt: input.schedule.attempt,
    seed: input.schedule.seed,
    modelRef: {
      providerId: provider,
      modelId:
        input.arm === "frontier_reference"
          ? "gpt-5.6-sol"
          : input.arm,
    },
    startedAt: "2026-07-25T12:00:00.000Z",
    completedAt: "2026-07-25T12:00:01.000Z",
    output: {
      harnessGrade: {
        reward: input.reward,
        decisionAccepted: true,
        components: {
          constraints: 1,
          portfolioValue: input.reward,
          riskControls: input.reward,
          rationale: input.reward,
        },
      },
      toolSequence: [
        "get_portfolio_snapshot",
        "submit_budget_decision",
      ],
      terminalDecision: true,
    },
    runtimeEventRefs: [],
    artifactRefs: [],
    privilegedOutcomeRef: null,
    infrastructureError: null,
    costUsd: null,
    latencyMs: 1_000,
    userInterventions: 0,
    metadata: {
      requestId:
        `request-${input.arm}-${input.schedule.taskId}-${input.schedule.attempt}`,
      validToolTrace: true,
      policyFailure: null,
      providerSamplingSupport: {
        seed: input.arm !== "frontier_reference",
        temperature: true,
        topP: true,
      },
      providerResponseIdentity: JSON.stringify({
        provider,
        model:
          input.arm === "frontier_reference"
            ? "gpt-5.6-sol"
            : input.arm,
      }),
      providerResponseFacts: [{
        requestId: "request-1",
      }],
      promptTokens: 100,
      generatedTokens: 20,
    },
  };
}

function tasksetFixture(): Taskset {
  const agentRelease = {
    id: "agent-marketing",
    contentHash: sha256("agent"),
  };
  return {
    id: "taskset-marketing",
    profileId: "profile-fixture",
    revision: 1,
    contentHash: sha256("taskset"),
    profileRelease: {
      id: "profile-marketing",
      revision: 1,
      contentHash: sha256("profile"),
    },
    metadata: {},
    environment: {
      defaultTimeoutMs: 120_000,
      stateful: true,
      metadata: {
        benchmark: {
          id: "marketing-portfolio-v1",
          scorer: { implementationHash: sha256("scorer") },
        },
      },
      actionBindings: [
        {
          schemaVersion: "openpond.harnessActionBinding.v1",
          actionId: "get-portfolio-snapshot",
          modelToolName: "get_portfolio_snapshot",
          description: "Read the episode portfolio.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          actionSchemaHash: contentHash({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
          implementationHash: sha256("snapshot-implementation"),
          agentRelease,
          runtimeBindingId: "snapshot-runtime",
          capabilityReceiptHash: sha256("snapshot-capability"),
          sideEffect: "read",
          studentVisible: true,
          timeoutMs: 30_000,
          episodeArgumentBindings: [{
            argument: "scenarioId",
            source: "case_id",
          }],
        },
        {
          schemaVersion: "openpond.harnessActionBinding.v1",
          actionId: "submit-budget-decision",
          modelToolName: "submit_budget_decision",
          description: "Submit the episode decision.",
          inputSchema: {
            type: "object",
            properties: {
              allocations: { type: "array" },
              rationale: { type: "string" },
              riskControls: { type: "array" },
            },
            required: ["allocations", "rationale", "riskControls"],
            additionalProperties: false,
          },
          actionSchemaHash: contentHash({
            type: "object",
            properties: {
              allocations: { type: "array" },
              rationale: { type: "string" },
              riskControls: { type: "array" },
            },
            required: ["allocations", "rationale", "riskControls"],
            additionalProperties: false,
          }),
          implementationHash: sha256("decision-implementation"),
          agentRelease,
          runtimeBindingId: "decision-runtime",
          capabilityReceiptHash: sha256("decision-capability"),
          sideEffect: "write",
          studentVisible: true,
          timeoutMs: 30_000,
          episodeArgumentBindings: [{
            argument: "scenarioId",
            source: "case_id",
          }],
        },
      ],
    },
    tasks: Array.from({ length: 8 }, (_, index) => ({
      id: `frozen-${index + 1}`,
      split: "frozen_eval",
      input: { prompt: "Inspect the portfolio and submit a decision." },
      privilegedContextRef: `case-${index + 1}`,
      metadata: { caseId: `case-${index + 1}` },
    })),
  } as unknown as Taskset;
}

function baseVersionFixture(taskset: Taskset): ModelVersion {
  return {
    id: "model-version-0",
    modelId: "model-marketing",
    kind: "base_reference",
    version: 0,
    baseModel: {
      modelId: "Qwen/Qwen3-0.6B",
      revision: "c1899de289a04d12100db370d81485cdf75e47ca",
    },
    taskset: {
      id: taskset.id,
      revision: taskset.revision,
      contentHash: taskset.contentHash,
    },
    releaseGraph: {
      profileRelease: taskset.profileRelease,
      harnessRelease: {
        id: "harness-marketing",
        contentHash: sha256("harness"),
      },
      agentRelease:
        taskset.environment.actionBindings?.[0]?.agentRelease ?? null,
      grader: {
        id: "grader-marketing",
        contentHash: sha256("grader"),
      },
    },
  } as unknown as ModelVersion;
}

function baselineReportFixture(taskset: Taskset): BaselineReport {
  return {
    schemaVersion: "openpond.baselineReport.v1",
    id: "baseline-marketing-signal",
    tasksetId: taskset.id,
    tasksetHash: taskset.contentHash,
    graderSetHash: sha256("grader-set"),
    attemptRefs: Array.from({ length: 32 }, (_, index) => `attempt-${index}`),
    gradeRefs: Array.from({ length: 32 }, (_, index) => `grade-${index}`),
    passAtK: { "1": 0.5, "4": 0.75 },
    reward: {
      count: 32,
      mean: 0.5,
      min: 0,
      max: 1,
      variance: 0.25,
    },
    failureClusters: {},
    totalCostUsd: 1,
    userInterventions: 0,
    hackingChecksPassed: true,
    leakageChecksPassed: true,
    scope: {
      split: "train",
      taskCount: 8,
      attemptsPerTask: 4,
      selectionSeed: 17,
      selectionStrategy: "rft_easy_curriculum_v1",
      taskIdsHash: sha256("training-task-ids"),
      harnessContractHash:
        MARKETING_PORTFOLIO_HARNESS_CONTRACT_HASH,
      model: {
        providerId: "custom-openai-compatible",
        modelId: "Qwen/Qwen3-0.6B",
      },
      sampling: {
        maxOutputTokens: 1_024,
        temperature: 0.8,
        topP: 0.95,
      },
    },
    rftSignal: {
      requiredMixedRewardGroups: 2,
      mixedRewardGroups: 6,
      allCorrectRewardGroups: 1,
      allIncorrectRewardGroups: 1,
      unscoredGroups: 0,
      infrastructureFailures: 0,
      eligibleAttempts: 32,
      correctAttempts: 16,
      incorrectAttempts: 16,
      parseableAttempts: 32,
      passed: true,
    },
    createdAt: "2026-07-25T11:00:00.000Z",
  };
}
