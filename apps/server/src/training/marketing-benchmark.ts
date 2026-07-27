import {
  MARKETING_BENCHMARK_MINIMUM_CANDIDATE_SCORE,
  MARKETING_BENCHMARK_MINIMUM_IMPROVEMENT,
  MarketingBenchmarkSpecificationSchema,
  type BaselineReport,
  type ChatModelRef,
  type MarketingBenchmarkSpecification,
  type ModelVersion,
  type Taskset,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import {
  MARKETING_PORTFOLIO_HARNESS_CONTRACT_HASH,
} from "./marketing-portfolio-constraint-repair.js";

export const MARKETING_BENCHMARK_FRONTIER_MODEL = {
  providerId: "openai",
  modelId: "gpt-5.6-sol",
} as const satisfies ChatModelRef;

export const MARKETING_BENCHMARK_BASE_MODEL = {
  modelId: "Qwen/Qwen3-0.6B",
  revision: "c1899de289a04d12100db370d81485cdf75e47ca",
} as const;

export async function preregisterMarketingBenchmark(input: {
  store: SqliteStore;
  tasksetId: string;
  baselineReportId: string;
  baseModelVersionId?: string;
  minimumCandidateScore?: number;
  minimumImprovement?: number;
  createdAt?: string;
}): Promise<MarketingBenchmarkSpecification> {
  const taskset = await input.store.getTaskset(input.tasksetId);
  if (!taskset) {
    throw new Error(`Taskset ${input.tasksetId} was not found.`);
  }
  const baselineReport = (
    await input.store.listBaselineReports(taskset.id)
  ).find((report) => report.id === input.baselineReportId);
  if (!baselineReport) {
    throw new Error(
      `Baseline report ${input.baselineReportId} was not found for Taskset ${taskset.id}.`,
    );
  }
  const modelVersions = await input.store.listModelVersions({
    profileId: taskset.profileId,
  });
  const baseVersion = modelVersions.find((version) =>
    version.kind === "base_reference" &&
    version.version === 0 &&
    version.taskset.id === taskset.id &&
    version.taskset.revision === taskset.revision &&
    version.taskset.contentHash === taskset.contentHash &&
    (
      input.baseModelVersionId
        ? version.id === input.baseModelVersionId
        : version.baseModel.modelId ===
            MARKETING_BENCHMARK_BASE_MODEL.modelId &&
          version.baseModel.revision ===
            MARKETING_BENCHMARK_BASE_MODEL.revision
    )
  );
  if (!baseVersion) {
    throw new Error(
      "Preregistration requires the requested exact Qwen3 Model v0 release for this Taskset.",
    );
  }
  const existing = (
    await input.store.listMarketingBenchmarkSpecifications({
      tasksetId: taskset.id,
    })
  ).find(
    (specification) =>
      specification.arms[0]?.modelVersionId === baseVersion.id,
  );
  if (existing) return existing;
  const minimumImprovement =
    input.minimumImprovement
    ?? MARKETING_BENCHMARK_MINIMUM_IMPROVEMENT;
  const minimumCandidateScore =
    input.minimumCandidateScore
    ?? MARKETING_BENCHMARK_MINIMUM_CANDIDATE_SCORE;
  return input.store.saveMarketingBenchmarkSpecification(
    createMarketingBenchmarkSpecification({
      taskset,
      baseVersion,
      baselineReport,
      minimumCandidateScore,
      minimumImprovement,
      authoringModel: taskset.authoringProvenance.model,
      createdAt: input.createdAt,
    }),
  );
}

export function createMarketingBenchmarkSpecification(input: {
  taskset: Taskset;
  baseVersion: ModelVersion;
  baselineReport: BaselineReport;
  minimumCandidateScore: number;
  minimumImprovement: number;
  authoringModel: ChatModelRef | null;
  createdAt?: string;
}): MarketingBenchmarkSpecification {
  assertMarketingBenchmarkInputs(
    input.taskset,
    input.baseVersion,
    input.baselineReport,
  );
  const createdAt = input.createdAt ?? new Date().toISOString();
  const actionBindings = input.taskset.environment.actionBindings!;
  const frozenTasks = input.taskset.tasks.filter(
    (task) => task.split === "frozen_eval",
  );
  const attemptSchedule = frozenTasks.flatMap((task, taskIndex) =>
    Array.from({ length: 4 }, (_, attempt) => ({
      taskId: task.id,
      attempt,
      seed: 25_000 + taskIndex * 101 + attempt,
    })),
  );
  const baseModel = input.baseVersion.baseModel;
  const core = {
    schemaVersion: "openpond.marketingBenchmarkSpecification.v1" as const,
    profileId: input.taskset.profileId,
    benchmarkId: "marketing-portfolio-v1" as const,
    taskset: {
      id: input.taskset.id,
      revision: input.taskset.revision,
      contentHash: input.taskset.contentHash,
    },
    harnessRelease: input.baseVersion.releaseGraph.harnessRelease,
    policyHarnessContractHash:
      MARKETING_PORTFOLIO_HARNESS_CONTRACT_HASH,
    profileRelease: input.baseVersion.releaseGraph.profileRelease,
    agentRelease: input.baseVersion.releaseGraph.agentRelease!,
    grader: input.baseVersion.releaseGraph.grader,
    actions: actionBindings.map((binding) => ({
      id: binding.actionId,
      name: binding.modelToolName,
      schemaHash: binding.actionSchemaHash,
      implementationHash: binding.implementationHash,
    })),
    frozenTaskIds: frozenTasks.map((task) => task.id),
    attemptsPerTask: 4 as const,
    attemptSchedule,
    sampling: {
      maxOutputTokens: 1_024,
      temperature: 0.2,
      topP: 0.95,
    },
    maxTurns: 8,
    timeoutMs: Math.min(
      input.taskset.environment.defaultTimeoutMs,
      10 * 60_000,
    ),
    privateCaseContractHash: contentHash(
      frozenTasks.map((task) => ({
        taskId: task.id,
        privilegedContextRef: task.privilegedContextRef,
      })),
    ),
    arms: [
      {
        arm: "base" as const,
        model: {
          providerId: "custom-openai-compatible" as const,
          modelId: `${baseModel.modelId}@${baseModel.revision}`,
        },
        modelProjectId: input.baseVersion.modelId,
        modelVersion: 0,
        modelVersionId: input.baseVersion.id,
        baseRepository: baseModel.modelId,
        baseRevision: baseModel.revision,
        adapterContentHash: null,
        providerResponseIdentityRequired: false,
      },
      {
        arm: "candidate" as const,
        model: {
          providerId: "custom-openai-compatible" as const,
          modelId: `${baseModel.modelId}@${baseModel.revision}:lora:v1`,
        },
        modelProjectId: input.baseVersion.modelId,
        modelVersion: 1,
        modelVersionId: null,
        baseRepository: baseModel.modelId,
        baseRevision: baseModel.revision,
        adapterContentHash: null,
        providerResponseIdentityRequired: false,
      },
      {
        arm: "frontier_reference" as const,
        model: MARKETING_BENCHMARK_FRONTIER_MODEL,
        modelProjectId: null,
        modelVersion: null,
        modelVersionId: null,
        baseRepository: null,
        baseRevision: null,
        adapterContentHash: null,
        providerResponseIdentityRequired: true,
      },
    ],
    promotionGate: {
      primaryMetric: "unique_task_mean_deterministic_reward" as const,
      minimumCandidateScore: input.minimumCandidateScore,
      minimumImprovement: input.minimumImprovement,
      criticalConstraintHardGates: [
        "valid_two_action_completion",
        "decision_constraints",
        "identity_alignment",
      ],
      frontierComparisonBlocksPromotion: false as const,
    },
    preregistration: {
      baselineReport: {
        id: input.baselineReport.id,
        contentHash: contentHash(input.baselineReport),
      },
      split: "train" as const,
      model: input.baselineReport.scope!.model,
      observedMeanReward: input.baselineReport.reward.mean!,
      observedRewardVariance: input.baselineReport.reward.variance!,
      mixedRewardGroups: input.baselineReport.rftSignal!.mixedRewardGroups,
      rftSignalPassed: true as const,
      thresholdsLockedBeforeTraining: true as const,
    },
    authoringModel: input.authoringModel,
    createdAt,
  };
  const contentHashValue = contentHash(core);
  return MarketingBenchmarkSpecificationSchema.parse({
    ...core,
    id: `marketing_benchmark_${contentHashValue.slice(0, 24)}`,
    contentHash: contentHashValue,
  });
}

function assertMarketingBenchmarkInputs(
  taskset: Taskset,
  baseVersion: ModelVersion,
  baselineReport: BaselineReport,
): void {
  const benchmark = taskset.environment.metadata.benchmark;
  const actionBindings = taskset.environment.actionBindings ?? [];
  const frozenTasks = taskset.tasks.filter(
    (task) => task.split === "frozen_eval",
  );
  if (
    !benchmark
    || typeof benchmark !== "object"
    || Array.isArray(benchmark)
    || (benchmark as Record<string, unknown>).id !== "marketing-portfolio-v1"
    || !taskset.profileRelease
    || actionBindings.length !== 2
    || actionBindings[0]?.modelToolName !== "get_portfolio_snapshot"
    || actionBindings[1]?.modelToolName !== "submit_budget_decision"
    || frozenTasks.length !== 8
    || new Set(frozenTasks.map((task) => task.id)).size !== 8
  ) {
    throw new Error(
      "Marketing benchmark Taskset is not the immutable 8-task two-action contract.",
    );
  }
  if (
    baseVersion.kind !== "base_reference"
    || baseVersion.version !== 0
    || baseVersion.taskset.id !== taskset.id
    || baseVersion.taskset.revision !== taskset.revision
    || baseVersion.taskset.contentHash !== taskset.contentHash
    || !baseVersion.releaseGraph.agentRelease
  ) {
    throw new Error(
      "Marketing benchmark base Model Version does not match the Taskset release graph.",
    );
  }
  if (
    baselineReport.tasksetId !== taskset.id
    || baselineReport.tasksetHash !== taskset.contentHash
    || baselineReport.scope?.split !== "train"
    || baselineReport.scope.taskCount !== 8
    || baselineReport.scope.attemptsPerTask !== 4
    || baselineReport.scope.harnessContractHash
      !== MARKETING_PORTFOLIO_HARNESS_CONTRACT_HASH
    || baselineReport.reward.mean === null
    || baselineReport.reward.variance === null
    || baselineReport.rftSignal?.passed !== true
    || baselineReport.scope.model.modelId
      !== baseVersion.baseModel.modelId
  ) {
    throw new Error(
      "Marketing benchmark preregistration requires a passing 8-task × 4-attempt train-signal report for the exact Taskset.",
    );
  }
}
