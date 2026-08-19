import {
  ModelEvaluationReceiptSchema,
  ModelRunSchema,
  summarizeModelEvaluationTaskEfficiency,
  type ChatModelRef,
  type CodexReasoningEffort,
  type ModelRun,
  type OpenPondProfileState,
} from "@openpond/contracts";
import { compareBenchmarkRuns } from "@openpond/evals";
import { contentHash } from "@openpond/harness";

import { loadLocalHarnessRuntimeFromRelease } from "../harness/local-harness-skill-runtime.js";
import type { SqliteStore } from "../store/store.js";
import type { createTaskEvaluationService } from "./evaluation-service.js";
import {
  BenchmarkSpendBudget,
  benchmarkAttemptsInfrastructureValid,
  benchmarkEfficiency,
  totalPlannedTasks,
  type HarnessRefinerExecutionPlanItem,
} from "./harness-refiner-benchmark-protocol.js";
import {
  createResultManifest,
  loadLatestManagedResult,
  preserveProfileResult,
  writeManagedResult,
} from "./harness-refiner-benchmark-result-persistence.js";
import {
  checkpointAttempt,
  classifyComparison,
  combineRetriedBenchmarkStage,
  comparisonInvalidReasons,
  emptyEvaluationAccounting,
  frozenToolEvidence,
  loadBenchmarkAttemptEvidenceByIds,
  loadCompletedBenchmarkStage,
  loadOrReconstructEvidenceSnapshot,
  releasedHarness,
  type CompletedBenchmarkStage,
} from "./harness-refiner-benchmark-service-support.js";
import type { HostedTokenPricing } from "./hosted-token-pricing.js";

type Evaluation = ReturnType<typeof createTaskEvaluationService>;

export async function resumeHarnessRefinerComparison(input: {
  deps: {
    store: SqliteStore;
    storeDir: string;
    evaluation: Evaluation;
    loadProfileState: () => Promise<OpenPondProfileState>;
    now: () => string;
  };
  benchmarkInput: {
    model: ChatModelRef;
    reasoningEffort: CodexReasoningEffort | "none" | null;
    seeds: number[];
    repetitions: number;
  };
  modelRun: ModelRun;
  signal: AbortSignal;
  workspace: NonNullable<Awaited<ReturnType<SqliteStore["getHarnessWorkspace"]>>>;
  taskset: NonNullable<Awaited<ReturnType<SqliteStore["getTaskset"]>>>;
  executionPlan: HarnessRefinerExecutionPlanItem[];
  baselinePlan: HarnessRefinerExecutionPlanItem;
  adaptationPlan: HarnessRefinerExecutionPlanItem;
  candidatePlan: HarnessRefinerExecutionPlanItem;
  admittedPricing: HostedTokenPricing;
  budget: BenchmarkSpendBudget;
  totalAttempts: number;
}): Promise<ModelRun> {
  const {
    deps,
    benchmarkInput,
    modelRun,
    signal,
    workspace,
    taskset,
    executionPlan,
    admittedPricing,
    budget,
    totalAttempts,
  } = input;
  const [baseline, adaptation, priorCandidate] =
    await Promise.all([
      loadCompletedBenchmarkStage({
        store: deps.store,
        modelRunId: modelRun.id,
        tasksetId: taskset.id,
        plan: input.baselinePlan,
      }),
      loadCompletedBenchmarkStage({
        store: deps.store,
        modelRunId: modelRun.id,
        tasksetId: taskset.id,
        plan: input.adaptationPlan,
      }),
      loadCompletedBenchmarkStage({
        store: deps.store,
        modelRunId: modelRun.id,
        tasksetId: taskset.id,
        plan: input.candidatePlan,
      }),
    ]);
  const priorManifest = await loadLatestManagedResult(deps.storeDir, modelRun.id);
  if (!priorManifest) {
    throw new Error("Comparison recovery requires the durable benchmark result manifest.");
  }
  const sequentialAttemptIds = modelRun.evaluationProgress?.accounting?.attempts
    .filter((attempt) => attempt.phase === "candidate_adaptation")
    .map((attempt) => attempt.attemptId) ?? [];
  const candidateAdaptationAttempts = await loadBenchmarkAttemptEvidenceByIds({
    store: deps.store,
    tasksetId: taskset.id,
    attemptIds: sequentialAttemptIds,
  });
  if (
    priorManifest.tasksetRelease.id !== baseline.run.tasksetRelease.id
    || priorManifest.tasksetRelease.contentHash
      !== baseline.run.tasksetRelease.contentHash
    || priorManifest.harness.baseline.contentHash
      !== baseline.run.harnessRelease.contentHash
  ) {
    throw new Error("Comparison recovery manifest drifted from the admitted benchmark.");
  }
  const currentReleaseRef = workspace.currentChannel.release;
  if (!currentReleaseRef) {
    throw new Error("Comparison recovery has no candidate Harness release.");
  }
  const candidateRecord = await deps.store.getHarnessReleaseRecord(
    currentReleaseRef.contentHash,
  );
  if (!candidateRecord || candidateRecord.workspaceId !== workspace.id) {
    throw new Error("Comparison recovery candidate Harness is unavailable.");
  }
  const candidateRuntime = await loadLocalHarnessRuntimeFromRelease({
    workspace,
    release: candidateRecord,
  });
  const candidateHarness = releasedHarness(
    candidateRuntime.release,
    candidateRuntime.instructionContext,
  );
  const evidenceSnapshot = await loadOrReconstructEvidenceSnapshot({
    store: deps.store,
    storeDir: deps.storeDir,
    modelRun,
    attempts: [
      ...baseline.attempts.map((result) => ({
        result,
        cohort: "held_out" as const,
      })),
      ...adaptation.attempts.map((result) => ({
        result,
        cohort: "adaptation" as const,
      })),
    ],
  });
  const retryStage = async (
    prior: CompletedBenchmarkStage,
    plan: HarnessRefinerExecutionPlanItem,
    stage: "candidate_adaptation" | "candidate",
    cohort: "adaptation" | "held_out",
  ) => {
    const taskIds = prior.attempts
      .filter((attempt) =>
        attempt.grade.score === null
        || attempt.grade.failureClass === "infrastructure_failure"
      )
      .map((attempt) => attempt.attempt.taskId);
    if (!taskIds.length) return prior;
    const retried = await deps.evaluation.executeBenchmark({
      tasksetId: taskset.id,
      phase: "candidate",
      model: benchmarkInput.model,
      reasoningEffort: benchmarkInput.reasoningEffort,
      seeds: benchmarkInput.seeds,
      repetitions: benchmarkInput.repetitions,
      split: plan.split as never,
      taskIds,
      sampling: { maxOutputTokens: 4_096, temperature: 0, topP: 1 },
      releasedHarness: candidateHarness,
      hostedTokenPricing: admittedPricing,
      parentModelRunId: modelRun.id,
      signal,
      toolEvidence: frozenToolEvidence(evidenceSnapshot, "replay", cohort),
      onAttemptComplete: async (result) => {
        signal.throwIfAborted();
        budget.assertAvailable(`${stage} infrastructure retry`);
        budget.charge(
          result.attempt.costUsd,
          `${stage} infrastructure retry foreground work`,
        );
        const grader = deps.evaluation.consumeGraderUsage([result.attempt.id]);
        budget.charge(grader.costUsd, `${stage} infrastructure retry grading`);
        await checkpointAttempt(deps.store, modelRun.id, {
          stage,
          completedAttempts: totalAttempts,
          totalAttempts,
          result,
          grader,
          observedSpendUsd: budget.observedSpendUsd,
        });
      },
    });
    return combineRetriedBenchmarkStage({
      store: deps.store,
      tasksetId: taskset.id,
      parentModelRunId: modelRun.id,
      prior,
      retries: retried.attempts,
      createdAt: deps.now(),
    });
  };
  const candidate = await retryStage(
    priorCandidate,
    input.candidatePlan,
    "candidate",
    "held_out",
  );
  const comparison = compareBenchmarkRuns({
    id: `benchmark-comparison-${contentHash([
      baseline.run.contentHash,
      candidate.run.contentHash,
    ]).slice(0, 24)}`,
    baseline: baseline.run,
    candidate: candidate.run,
    primaryMetric: taskset.benchmark!.primaryMetric,
    qualityGate: taskset.benchmark!.qualityGate,
    createdAt: deps.now(),
    metadata: {
      sourceTasksetId: taskset.id,
      benchmarkDefinitionId: taskset.benchmark!.definitionId,
      recoveredInfrastructureAttempts: true,
    },
  });
  await deps.store.saveBenchmarkComparison({ tasksetId: taskset.id, comparison });
  const lineage = {
    ...priorManifest.lineage,
    candidateRelease: {
      id: priorManifest.lineage.candidateRelease.id,
      contentHash: priorManifest.lineage.candidateRelease.contentHash,
    },
  };
  const frozenEvidence = evidenceSnapshot.manifest();
  const manifest = createResultManifest({
    modelRunId: modelRun.id,
    model: benchmarkInput.model,
    upstreamModel: priorManifest.upstreamModel,
    reasoningEffort: benchmarkInput.reasoningEffort,
    baseline: baseline.run,
    adaptation: adaptation.run,
    refiner: priorManifest.refiner,
    candidateAdaptation: priorManifest.candidateAdaptation,
    candidate: candidate.run,
    comparison,
    executionPlan,
    evidenceSnapshot: frozenEvidence,
    lineage,
    createdAt: deps.now(),
  });
  const artifactPath = await writeManagedResult(deps.storeDir, modelRun.id, manifest);
  const profile = await deps.loadProfileState();
  const profileGit = await preserveProfileResult({
    profile,
    modelRunId: modelRun.id,
    workspaceId: workspace.id,
    storeDir: deps.storeDir,
    manifest,
  });
  const infrastructureValid = benchmarkAttemptsInfrastructureValid([
    ...baseline.attempts,
    ...adaptation.attempts,
    ...candidateAdaptationAttempts,
    ...candidate.attempts,
  ]);
  const harnessChanged = baseline.run.harnessRelease.contentHash
    !== candidate.run.harnessRelease.contentHash;
  const terminalClassification = classifyComparison({
    comparison,
    baseline: baseline.run,
    adaptation: adaptation.run,
    candidate: candidate.run,
    candidateAdaptation: priorManifest.candidateAdaptation,
    harnessChanged,
    lineageValid: lineage.valid,
    infrastructureValid,
  });
  const invalidReasons = comparisonInvalidReasons({
    baseline: baseline.run,
    adaptation: adaptation.run,
    candidateAdaptation: priorManifest.candidateAdaptation,
    candidate: candidate.run,
    harnessChanged,
    lineageValid: lineage.valid,
    infrastructureValid,
  });
  const finalRunCheckpoint = await deps.store.getModelRun(modelRun.id) ?? modelRun;
  const finalAccounting = finalRunCheckpoint.evaluationProgress?.accounting
    ?? emptyEvaluationAccounting();
  const taskEfficiency = summarizeModelEvaluationTaskEfficiency({
    attempts: finalAccounting.attempts,
    targetTaskCount: totalPlannedTasks(executionPlan),
  }).summary;
  const efficiency = benchmarkEfficiency({
    baselineTokens: baseline.run.usage.totalTokens,
    candidateTokens: candidate.run.usage.totalTokens,
    refinerTokens: finalAccounting.usage.refiner.totalTokens,
    graderTokens: finalAccounting.usage.grader.totalTokens,
  });
  const receiptCore = {
    schemaVersion: "openpond.modelEvaluationReceipt.v1" as const,
    benchmarkId: "harness-refiner" as const,
    resultManifest: { id: manifest.id, contentHash: manifest.contentHash, artifactPath },
    stages: {
      baseline: { id: baseline.run.id, contentHash: baseline.run.contentHash },
      adaptation: { id: adaptation.run.id, contentHash: adaptation.run.contentHash },
      candidateAdaptation: {
        id: priorManifest.candidateAdaptation.id,
        contentHash: priorManifest.candidateAdaptation.contentHash,
      },
      refiner: {
        id: priorManifest.refiner.id,
        contentHash: priorManifest.refiner.contentHash,
      },
      candidate: { id: candidate.run.id, contentHash: candidate.run.contentHash },
      comparison: { id: comparison.id, contentHash: comparison.contentHash },
    },
    usage: finalAccounting.usage,
    quality: {
      baselinePassRate: comparison.baselinePassRate,
      candidatePassRate: comparison.candidatePassRate,
      adaptationBaselinePassRate: adaptation.run.passedCount / adaptation.run.attemptCount,
      adaptationCandidatePassRate:
        priorManifest.candidateAdaptation.passedCount
          / priorManifest.candidateAdaptation.attemptCount,
      adaptationCandidatePassed:
        priorManifest.candidateAdaptation.passedCount
          === priorManifest.candidateAdaptation.attemptCount,
      heldOutCandidatePassed: candidate.run.passedCount === candidate.run.attemptCount,
      passed:
        comparison.qualityPassed
        && priorManifest.candidateAdaptation.passedCount
          === priorManifest.candidateAdaptation.attemptCount
        && candidate.run.passedCount === candidate.run.attemptCount
        && infrastructureValid
        && terminalClassification !== "infrastructure_failure",
    },
    foregroundTokenDelta: comparison.foregroundTokenDelta,
    foregroundTokenDeltaPercent: comparison.foregroundTokenDeltaPercent,
    taskEfficiency,
    efficiency,
    budget: {
      maximumSpendUsd: budget.maximumSpendUsd,
      observedSpendUsd: budget.observedSpendUsd,
      enforced: true,
    },
    evidenceSnapshot: { id: frozenEvidence.id, contentHash: frozenEvidence.contentHash },
    lineage,
    invalidReasons,
    attempts: finalAccounting.attempts,
    terminalClassification,
    profileGit: profileGit
      ? { ref: profileGit.ref, commit: profileGit.commit, baseCommit: profileGit.baseCommit }
      : null,
  };
  const receipt = ModelEvaluationReceiptSchema.parse({
    ...receiptCore,
    contentHash: contentHash(receiptCore),
  });
  const completedAt = deps.now();
  const latestRun = await deps.store.getModelRun(modelRun.id) ?? modelRun;
  const infrastructureFailure = terminalClassification === "infrastructure_failure";
  return deps.store.saveModelRun(ModelRunSchema.parse({
    ...latestRun,
    status: infrastructureFailure ? "failed" : "succeeded",
    harnessRelease: baseline.run.harnessRelease,
    receipt,
    failure: infrastructureFailure
      ? "Benchmark attempts did not reach the model because the Work runtime failed."
      : null,
    evaluationProgress: {
      ...latestRun.evaluationProgress,
      stage: "comparison",
      completedAttempts: totalAttempts,
      totalAttempts,
    },
    completedAt,
    updatedAt: completedAt,
  }));
}
