import {
  CodexReasoningEffortSchema,
  ModelEvaluationReceiptSchema,
  ModelRunSchema,
  summarizeModelEvaluationTaskEfficiency,
  type ChatModelRef,
  type CodexReasoningEffort,
  type ModelProject,
  type ModelRun,
  type OpenPondProfileState,
} from "@openpond/contracts";
import {
  contentHash,
  type HarnessRefinerMessage,
} from "@openpond/harness";
import type { SqliteStore } from "../store/store.js";
import { forkLocalHarnessWorkspaceFromRelease } from "../harness/local-harness-workspace-service.js";
import { resolveSelectedLocalHarnessRelease } from "../harness/local-harness-selection.js";
import { loadLocalHarnessRuntimeFromRelease } from "../harness/local-harness-skill-runtime.js";
import type { createTaskEvaluationService } from "./evaluation-service.js";
import type { createBenchmarkTasksetService } from "./benchmark-tasksets.js";
import {
  BenchmarkEvidenceSnapshot,
  BenchmarkSpendBudget,
  benchmarkAttemptsInfrastructureValid,
  benchmarkEfficiency,
  completedBeforeStage,
  createHarnessRefinerExecutionPlan,
  totalPlannedAttempts,
  totalPlannedTasks,
  type HarnessRefinerExecutionPlanItem,
} from "./harness-refiner-benchmark-protocol.js";
import type { HostedTokenPricing } from "./hosted-token-pricing.js";
import { resumeHarnessRefinerComparison } from "./harness-refiner-benchmark-comparison-recovery.js";
import { runSequentialHarnessAdaptation } from "./harness-refiner-benchmark-sequential-stage.js";
import { loadSequentialAdaptationCheckpoint } from
  "./harness-refiner-benchmark-sequential-checkpoint.js";
import {
  createResultManifest,
  ensureBaseVersion,
  loadLatestManagedResult,
  preserveProfileResult,
  writeManagedResult,
} from "./harness-refiner-benchmark-result-persistence.js";
import {
  checkpointAttempt,
  checkpointEvidenceSnapshot,
  classifyComparison,
  comparisonInvalidReasons,
  completedStage,
  emptyEvaluationAccounting,
  frozenToolEvidence,
  loadCompletedBenchmarkStage,
  loadOrReconstructEvidenceSnapshot,
  modelVersionId,
  releasedHarness,
  requireModelProject,
  requirePlanStage,
  safeError,
  updateProgress,
  type BenchmarkAttemptEvidence,
  type CompletedBenchmarkStage,
} from "./harness-refiner-benchmark-service-support.js";

type Evaluation = ReturnType<typeof createTaskEvaluationService>;
type EvaluationAttempt = Awaited<ReturnType<Evaluation["execute"]>>;
type BenchmarkTasksets = ReturnType<typeof createBenchmarkTasksetService>;
type BenchmarkRefinerModelStream = (input: {
  model: ChatModelRef;
  messages: HarnessRefinerMessage[];
  signal: AbortSignal;
  pricing: HostedTokenPricing;
}) => AsyncIterable<{ text?: string; usage?: unknown; costUsd?: number }>;

type StartBenchmarkInput = {
  modelId: string;
  profileId: string;
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | "none" | null;
  seeds: number[];
  repetitions: number;
  maximumSpendUsd: number;
};

type ActiveBenchmarkRun = {
  controller: AbortController;
  execution: Promise<ModelRun>;
};

class BenchmarkRunCancelledError extends Error {
  constructor() {
    super("Benchmark cancelled by operator.");
    this.name = "BenchmarkRunCancelledError";
  }
}

const activeRuns = new Map<string, ActiveBenchmarkRun>();

export function createHarnessRefinerBenchmarkService(deps: {
  store: SqliteStore;
  storeDir: string;
  evaluation: Evaluation;
  benchmarkTasksets: BenchmarkTasksets;
  loadProfileState: () => Promise<OpenPondProfileState>;
  refinerStream: BenchmarkRefinerModelStream;
  resolveUpstreamModel(model: ChatModelRef): Promise<{
    providerId: string;
    modelId: string;
    revision: string;
    pricing: HostedTokenPricing;
  }>;
  now?: () => string;
}) {
  const now = deps.now ?? (() => new Date().toISOString());

  async function start(input: StartBenchmarkInput): Promise<ModelRun> {
    if (!Number.isFinite(input.maximumSpendUsd) || input.maximumSpendUsd <= 0) {
      throw new Error("Harness Refiner benchmark maximum spend must be greater than zero.");
    }
    const project = await requireModelProject(deps.store, input.modelId, input.profileId);
    let taskset = await deps.benchmarkTasksets.ensureHarnessRefiner({
      profileId: input.profileId,
    });
    if (!taskset.benchmark) throw new Error("Harness Refiner Taskset is unavailable.");
    if (taskset.graders.some(
      (grader) => grader.kind === "model_judge"
        && grader.rewardEligible
        && grader.calibrationStatus !== "passed",
    )) {
      const calibration = await deps.evaluation.calibrateModelJudges(taskset.id);
      if (!calibration.passed) {
        throw new Error("Harness Refiner model judge did not pass its declared calibration fixtures.");
      }
      taskset = calibration.taskset;
    }
    const executionPlan = createHarnessRefinerExecutionPlan({
      taskset,
      seeds: input.seeds,
      repetitions: input.repetitions,
    });
    const selectedHarness = await resolveSelectedLocalHarnessRelease(deps.store);
    if (!selectedHarness) throw new Error("A selected local Harness is required.");
    const upstreamModel = await deps.resolveUpstreamModel(input.model);
    const startedAt = now();
    const id = `model_run_${contentHash({
      modelId: project.id,
      taskset: taskset.contentHash,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      seeds: input.seeds,
      repetitions: input.repetitions,
      startedAt,
    }).slice(0, 24)}`;
    const isolated = await forkLocalHarnessWorkspaceFromRelease({
      store: deps.store,
      storeDir: deps.storeDir,
      id: `benchmark-${id}`,
      ownerId: `benchmark:${id}`,
      name: `Harness Refiner ${id}`,
      sourceRelease: {
        id: selectedHarness.harnessRelease.id,
        contentHash: selectedHarness.harnessRelease.contentHash,
      },
      now,
    });
    await deps.store.setHarnessBackgroundReviewSettings({
      workspaceId: isolated.workspace.id,
      enabled: false,
      updatedAt: now(),
    });
    const versionId = modelVersionId(project.id);
    const prepared = await deps.store.saveModelRun(ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1",
      id,
      modelId: project.id,
      modelVersionId: versionId,
      profileId: input.profileId,
      kind: "evaluation",
      status: "running",
      method: null,
      destinationId: null,
      taskset: {
        id: taskset.id,
        revision: taskset.revision,
        contentHash: taskset.contentHash,
      },
      harnessRelease: {
        id: isolated.release.harnessRelease.id,
        contentHash: isolated.release.harnessRelease.contentHash,
      },
      quote: null,
      evaluation: {
        benchmarkId: "harness-refiner",
        model: input.model,
        upstreamModel,
        reasoningEffort: input.reasoningEffort,
        seeds: input.seeds,
        repetitions: input.repetitions,
        maximumSpendUsd: input.maximumSpendUsd,
        attemptPlan: executionPlan,
      },
      evaluationProgress: {
        stage: "adaptation",
        completedAttempts: 0,
        totalAttempts: totalPlannedAttempts(executionPlan),
        accounting: emptyEvaluationAccounting(),
      },
      reward: null,
      receipt: null,
      adapterArtifactLineageId: null,
      failure: null,
      startedAt,
      completedAt: null,
      updatedAt: startedAt,
    }));
    const controller = new AbortController();
    const execution = executePass({
      input,
      project,
      modelRun: prepared,
      signal: controller.signal,
    })
      .finally(() => activeRuns.delete(id));
    activeRuns.set(id, { controller, execution });
    void execution.catch(() => undefined);
    return prepared;
  }

  async function cancel(modelRunId: string): Promise<ModelRun> {
    const run = await deps.store.getModelRun(modelRunId);
    if (
      !run
      || run.kind !== "evaluation"
      || run.evaluation?.benchmarkId !== "harness-refiner"
    ) {
      throw new Error("No Harness Refiner evaluation exists for this Model Run.");
    }
    if (run.status !== "running") return run;
    activeRuns.get(modelRunId)?.controller.abort(new BenchmarkRunCancelledError());
    const completedAt = now();
    return deps.store.saveModelRun(ModelRunSchema.parse({
      ...run,
      status: "cancelled",
      failure: "Benchmark cancelled by operator.",
      completedAt,
      updatedAt: completedAt,
    }));
  }

  async function resume(modelRunId: string): Promise<ModelRun> {
    const run = await deps.store.getModelRun(modelRunId);
    if (
      !run
      || run.kind !== "evaluation"
      || run.evaluation?.benchmarkId !== "harness-refiner"
    ) {
      throw new Error("No Harness Refiner evaluation exists for this Model Run.");
    }
    if (activeRuns.has(modelRunId) || run.status === "running") return run;
    const canResumeFromRefiner =
      run.evaluationProgress?.stage === "refiner"
      && run.evaluationProgress?.completedAttempts
        === completedBeforeStage(run.evaluation.attemptPlan, "candidate_adaptation");
    const candidateAdaptationStart = completedBeforeStage(
      run.evaluation.attemptPlan,
      "candidate_adaptation",
    );
    const candidateAdaptationEnd = candidateAdaptationStart
      + requirePlanStage(run.evaluation.attemptPlan, "candidate_adaptation").attemptCount;
    const sequentialCheckpoint = await loadSequentialAdaptationCheckpoint({
      storeDir: deps.storeDir,
      modelRunId: run.id,
    });
    const canResumeFromCandidateAdaptation =
      run.evaluationProgress?.stage === "candidate_adaptation"
      && run.evaluationProgress.completedAttempts >= candidateAdaptationStart
      && run.evaluationProgress.completedAttempts <= candidateAdaptationEnd
      && Boolean(sequentialCheckpoint);
    const hasCompletedComparisonCheckpoint =
      ["candidate_adaptation", "candidate", "comparison"].includes(
        run.evaluationProgress?.stage ?? "",
      )
      && run.evaluationProgress?.completedAttempts
        === totalPlannedAttempts(run.evaluation.attemptPlan);
    const canResumeFromComparison = hasCompletedComparisonCheckpoint
      && Boolean(await loadLatestManagedResult(deps.storeDir, run.id));
    if (
      !["failed", "cancelled"].includes(run.status)
      || (
        !canResumeFromRefiner
        && !canResumeFromCandidateAdaptation
        && !canResumeFromComparison
      )
    ) {
      throw new Error(
        "Only a Harness Refiner run with a durable Refiner, sequential adaptation, or comparison checkpoint can resume.",
      );
    }
    const project = await requireModelProject(deps.store, run.modelId, run.profileId);
    const prepared = await deps.store.saveModelRun(ModelRunSchema.parse({
      ...run,
      status: "running",
      receipt: null,
      failure: null,
      completedAt: null,
      updatedAt: now(),
    }));
    const input: StartBenchmarkInput = {
      modelId: run.modelId,
      profileId: run.profileId,
      model: run.evaluation.model,
      reasoningEffort: run.evaluation.reasoningEffort === "none"
        ? "none"
        : run.evaluation.reasoningEffort === null
          ? null
          : CodexReasoningEffortSchema.parse(run.evaluation.reasoningEffort),
      seeds: run.evaluation.seeds,
      repetitions: run.evaluation.repetitions,
      maximumSpendUsd: run.evaluation.maximumSpendUsd,
    };
    const controller = new AbortController();
    const execution = executePass({
      input,
      project,
      modelRun: prepared,
      signal: controller.signal,
    }).finally(() => activeRuns.delete(modelRunId));
    activeRuns.set(modelRunId, { controller, execution });
    void execution.catch(() => undefined);
    return prepared;
  }

  async function reconcileInterrupted(): Promise<number> {
    const interrupted = (await deps.store.listModelRuns()).filter(
      (run) =>
        run.kind === "evaluation"
        && run.evaluation?.benchmarkId === "harness-refiner"
        && run.status === "running",
    );
    const completedAt = now();
    for (const run of interrupted) {
      await deps.store.saveModelRun(ModelRunSchema.parse({
        ...run,
        status: "failed",
        failure:
          "Benchmark execution was interrupted when the app server stopped. Resume it when an exact durable Refiner checkpoint is available; otherwise start a new run to preserve a complete causal record.",
        completedAt,
        updatedAt: completedAt,
      }));
    }
    return interrupted.length;
  }

  async function executePass(context: {
    input: StartBenchmarkInput;
    project: ModelProject;
    modelRun: ModelRun;
    signal: AbortSignal;
  }): Promise<ModelRun> {
    const { input, modelRun } = context;
    try {
      context.signal.throwIfAborted();
      if (!modelRun.harnessRelease) {
        throw new Error("Harness Refiner Model Run has no admitted Harness release.");
      }
      const workspaceId = `benchmark-${modelRun.id}`;
      const [workspace, release] = await Promise.all([
        deps.store.getHarnessWorkspace(workspaceId),
        deps.store.getHarnessReleaseRecord(modelRun.harnessRelease.contentHash),
      ]);
      if (!workspace || !release || release.workspaceId !== workspace.id) {
        throw new Error("The Harness pinned at admission is unavailable.");
      }
      const isolated = { workspace, release };
      const taskset = await deps.store.getTaskset(modelRun.taskset.id);
      if (!taskset?.benchmark) throw new Error("Harness Refiner Taskset changed before execution.");
      if (
        taskset.revision !== modelRun.taskset.revision
        || taskset.contentHash !== modelRun.taskset.contentHash
      ) {
        throw new Error("Harness Refiner Taskset release drifted after admission.");
      }
      const executionPlan = createHarnessRefinerExecutionPlan({
        taskset,
        seeds: input.seeds,
        repetitions: input.repetitions,
      });
      if (contentHash(executionPlan) !== contentHash(modelRun.evaluation?.attemptPlan)) {
        throw new Error("Harness Refiner execution plan changed after admission.");
      }
      const upstreamModel = modelRun.evaluation?.upstreamModel;
      if (!upstreamModel?.pricing) {
        throw new Error("Harness Refiner run has no admitted upstream pricing.");
      }
      const admittedPricing = upstreamModel.pricing;
      const totalAttempts = totalPlannedAttempts(executionPlan);
      const baselinePlan = requirePlanStage(executionPlan, "baseline");
      const adaptationPlan = requirePlanStage(executionPlan, "adaptation");
      const candidateAdaptationPlan = requirePlanStage(
        executionPlan,
        "candidate_adaptation",
      );
      const candidatePlan = requirePlanStage(executionPlan, "candidate");
      const resumeFromRefiner =
        modelRun.evaluationProgress?.stage === "refiner"
        && modelRun.evaluationProgress.completedAttempts
          === completedBeforeStage(executionPlan, "candidate_adaptation");
      const candidateAdaptationStart = completedBeforeStage(
        executionPlan,
        "candidate_adaptation",
      );
      const candidateAdaptationEnd = candidateAdaptationStart
        + candidateAdaptationPlan.attemptCount;
      const sequentialCheckpoint = await loadSequentialAdaptationCheckpoint({
        storeDir: deps.storeDir,
        modelRunId: modelRun.id,
      });
      const resumeFromCandidateAdaptation =
        modelRun.evaluationProgress?.stage === "candidate_adaptation"
        && modelRun.evaluationProgress.completedAttempts >= candidateAdaptationStart
        && modelRun.evaluationProgress.completedAttempts <= candidateAdaptationEnd
        && Boolean(sequentialCheckpoint);
      const resumeFromComparison =
        ["candidate_adaptation", "candidate", "comparison"].includes(
          modelRun.evaluationProgress?.stage ?? "",
        )
        && modelRun.evaluationProgress?.completedAttempts === totalAttempts;
      const budget = new BenchmarkSpendBudget(
        input.maximumSpendUsd,
        resumeFromRefiner || resumeFromCandidateAdaptation || resumeFromComparison
          ? modelRun.evaluationProgress?.accounting?.observedSpendUsd ?? 0
          : 0,
      );
      if (resumeFromComparison) {
        return resumeHarnessRefinerComparison({
          deps: {
            store: deps.store,
            storeDir: deps.storeDir,
            evaluation: deps.evaluation,
            loadProfileState: deps.loadProfileState,
            now,
          },
          benchmarkInput: input,
          modelRun,
          signal: context.signal,
          workspace: isolated.workspace,
          taskset,
          executionPlan,
          baselinePlan,
          adaptationPlan,
          candidatePlan,
          admittedPricing,
          budget,
          totalAttempts,
        });
      }
      let evidenceSnapshot = new BenchmarkEvidenceSnapshot();
      const observeStageAttempts = (
        stage: HarnessRefinerExecutionPlanItem["stage"],
        label: string,
      ) => {
        let completedInStage = modelRun.evaluationProgress?.accounting?.attempts
          .filter((attempt) => attempt.phase === stage).length ?? 0;
        return async (result: EvaluationAttempt) => {
          context.signal.throwIfAborted();
          budget.assertAvailable(label);
          budget.charge(result.attempt.costUsd, `${label} foreground work`);
          const grader = deps.evaluation.consumeGraderUsage([result.attempt.id]);
          budget.charge(grader.costUsd, `${label} grading`);
          completedInStage += 1;
          await checkpointAttempt(deps.store, modelRun.id, {
            stage,
            completedAttempts:
              completedBeforeStage(executionPlan, stage) + completedInStage,
            totalAttempts,
            result,
            grader,
            observedSpendUsd: budget.observedSpendUsd,
          });
        };
      };
      const baselineRuntime = await loadLocalHarnessRuntimeFromRelease({
        workspace: isolated.workspace,
        release: isolated.release,
      });
      const baselineHarness = releasedHarness(
        baselineRuntime.release,
        baselineRuntime.instructionContext,
      );
      let baseline: CompletedBenchmarkStage;
      let adaptation: CompletedBenchmarkStage;
      let adaptationAttempts: BenchmarkAttemptEvidence[];
      if (resumeFromRefiner || resumeFromCandidateAdaptation) {
        baseline = await loadCompletedBenchmarkStage({
          store: deps.store,
          modelRunId: modelRun.id,
          tasksetId: taskset.id,
          plan: baselinePlan,
        });
        adaptation = await loadCompletedBenchmarkStage({
          store: deps.store,
          modelRunId: modelRun.id,
          tasksetId: taskset.id,
          plan: adaptationPlan,
        });
        adaptationAttempts = adaptation.attempts;
        evidenceSnapshot = await loadOrReconstructEvidenceSnapshot({
          store: deps.store,
          storeDir: deps.storeDir,
          modelRun,
          attempts: [
            ...baseline.attempts.map((result) => ({ result, cohort: "held_out" as const })),
            ...adaptation.attempts.map((result) => ({ result, cohort: "adaptation" as const })),
          ],
        });
      } else {
        const executedAdaptation = await deps.evaluation.executeBenchmark({
          tasksetId: taskset.id,
          phase: "baseline",
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          seeds: input.seeds,
          repetitions: input.repetitions,
          split: adaptationPlan.split as never,
          taskIds: adaptationPlan.taskIds,
          sampling: { maxOutputTokens: 4_096, temperature: 0, topP: 1 },
          releasedHarness: baselineHarness,
          hostedTokenPricing: admittedPricing,
          parentModelRunId: modelRun.id,
          signal: context.signal,
          toolEvidence: frozenToolEvidence(evidenceSnapshot, "record", "adaptation"),
          onAttemptComplete: observeStageAttempts("adaptation", "adaptation baseline"),
        });
        adaptation = completedStage(executedAdaptation);
        adaptationAttempts = adaptation.attempts;
        await ensureBaseVersion({
          store: deps.store,
          project: context.project,
          modelRun,
          model: input.model,
          baseline: executedAdaptation.attempts[0]!,
        });
        if (
          adaptation.run.harnessRelease.id !== modelRun.harnessRelease.id
          || adaptation.run.harnessRelease.contentHash !== modelRun.harnessRelease.contentHash
        ) {
          throw new Error("Adaptation baseline drifted from the admitted Harness release.");
        }

        await checkpointEvidenceSnapshot(
          deps.store,
          deps.storeDir,
          modelRun.id,
          evidenceSnapshot.manifest(),
        );

        await updateProgress(deps.store, modelRun.id, {
          stage: "baseline",
          completedAttempts: completedBeforeStage(executionPlan, "baseline"),
          totalAttempts,
        });

        const executedBaseline = await deps.evaluation.executeBenchmark({
          tasksetId: taskset.id,
          phase: "baseline",
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          seeds: input.seeds,
          repetitions: input.repetitions,
          split: baselinePlan.split as never,
          taskIds: baselinePlan.taskIds,
          sampling: { maxOutputTokens: 4_096, temperature: 0, topP: 1 },
          releasedHarness: baselineHarness,
          hostedTokenPricing: admittedPricing,
          parentModelRunId: modelRun.id,
          signal: context.signal,
          toolEvidence: frozenToolEvidence(evidenceSnapshot, "record", "held_out"),
          onAttemptComplete: observeStageAttempts("baseline", "held-out baseline"),
        });
        baseline = completedStage(executedBaseline);
        if (
          baseline.run.harnessRelease.id !== modelRun.harnessRelease.id
          || baseline.run.harnessRelease.contentHash !== modelRun.harnessRelease.contentHash
        ) {
          throw new Error("Held-out baseline drifted from the admitted Harness release.");
        }
        await checkpointEvidenceSnapshot(
          deps.store,
          deps.storeDir,
          modelRun.id,
          evidenceSnapshot.manifest(),
        );
        await updateProgress(deps.store, modelRun.id, {
          stage: "refiner",
          completedAttempts: completedBeforeStage(executionPlan, "candidate_adaptation"),
          totalAttempts,
        });
      }
      if (
        (resumeFromRefiner || resumeFromCandidateAdaptation)
        && !modelRun.evaluationProgress?.evidenceSnapshot
      ) {
        throw new Error(
          "Sequential adaptation cannot resume because the interrupted run did not preserve its exact frozen evidence snapshot. Start a new run to preserve a valid causal comparison.",
        );
      }
      if (!resumeFromCandidateAdaptation) {
        await updateProgress(deps.store, modelRun.id, {
          stage: "candidate_adaptation",
          completedAttempts: candidateAdaptationStart,
          totalAttempts,
        });
      }
      const candidateAdaptation = await runSequentialHarnessAdaptation({
        store: deps.store,
        storeDir: deps.storeDir,
        evaluation: deps.evaluation,
        modelRun,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        taskset,
        taskIds: candidateAdaptationPlan.taskIds,
        seed: input.seeds[0]!,
        initialRuntime: baselineRuntime,
        evidenceSnapshot,
        budget,
        admittedPricing,
        refinerStream: deps.refinerStream,
        signal: context.signal,
        onAttemptComplete: observeStageAttempts(
          "candidate_adaptation",
          "sequential adaptation treatment",
        ),
        now,
      });
      const candidateRuntime = candidateAdaptation.runtime;
      const refinerStage = candidateAdaptation.refinerStage;
      const lineage = candidateAdaptation.lineage;
      const frozenEvidence = evidenceSnapshot.manifest();
      const harnessChanged = baseline.run.harnessRelease.contentHash
        !== candidateAdaptation.summary.finalHarness.contentHash;
      const candidateHarness = releasedHarness(
        candidateRuntime.release,
        candidateRuntime.instructionContext,
      );
      await updateProgress(deps.store, modelRun.id, {
        stage: "candidate",
        completedAttempts: completedBeforeStage(executionPlan, "candidate"),
        totalAttempts,
      });
      const candidate = await deps.evaluation.executeBenchmark({
        tasksetId: taskset.id,
        phase: "candidate",
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        seeds: input.seeds,
        repetitions: input.repetitions,
        split: candidatePlan.split as never,
        taskIds: candidatePlan.taskIds,
        sampling: { maxOutputTokens: 4_096, temperature: 0, topP: 1 },
        releasedHarness: candidateHarness,
        hostedTokenPricing: admittedPricing,
        parentModelRunId: modelRun.id,
        signal: context.signal,
        toolEvidence: frozenToolEvidence(evidenceSnapshot, "replay", "held_out"),
        onAttemptComplete: observeStageAttempts("candidate", "held-out candidate"),
      });
      if (!candidate.comparison) throw new Error("Paired benchmark comparison was not produced.");
      await updateProgress(deps.store, modelRun.id, {
        stage: "comparison",
        completedAttempts: totalAttempts,
        totalAttempts,
      });
      const manifest = createResultManifest({
        modelRunId: modelRun.id,
        model: input.model,
        upstreamModel: modelRun.evaluation!.upstreamModel,
        reasoningEffort: input.reasoningEffort,
        baseline: baseline.run,
        adaptation: adaptation.run,
        refiner: refinerStage,
        candidateAdaptation: candidateAdaptation.summary,
        candidate: candidate.run,
        comparison: candidate.comparison,
        executionPlan,
        evidenceSnapshot: frozenEvidence,
        lineage,
        createdAt: now(),
      });
      const artifactPath = await writeManagedResult(deps.storeDir, modelRun.id, manifest);
      const profile = await deps.loadProfileState();
      const profileGit = await preserveProfileResult({
        profile,
        modelRunId: modelRun.id,
        workspaceId: isolated.workspace.id,
        storeDir: deps.storeDir,
        manifest,
      });
      await ensureBaseVersion({
        store: deps.store,
        project: context.project,
        modelRun,
        model: input.model,
        baseline: baseline.attempts[0]!,
      });
      const infrastructureValid = benchmarkAttemptsInfrastructureValid([
        ...baseline.attempts,
        ...adaptationAttempts,
        ...candidateAdaptation.attempts,
        ...candidate.attempts,
      ]);
      const terminalClassification = classifyComparison({
        comparison: candidate.comparison,
        baseline: baseline.run,
        adaptation: adaptation.run,
        candidate: candidate.run,
        harnessChanged,
        candidateAdaptation: candidateAdaptation.summary,
        lineageValid: lineage.valid,
        infrastructureValid,
      });
      const invalidReasons = comparisonInvalidReasons({
        baseline: baseline.run,
        adaptation: adaptation.run,
        candidateAdaptation: candidateAdaptation.summary,
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
        benchmarkId: "harness-refiner",
        resultManifest: {
          id: manifest.id,
          contentHash: manifest.contentHash,
          artifactPath,
        },
        stages: {
          baseline: { id: baseline.run.id, contentHash: baseline.run.contentHash },
          adaptation: {
            id: adaptation.run.id,
            contentHash: adaptation.run.contentHash,
          },
          candidateAdaptation: {
            id: candidateAdaptation.summary.id,
            contentHash: candidateAdaptation.summary.contentHash,
          },
          refiner: { id: refinerStage.id, contentHash: refinerStage.contentHash },
          candidate: { id: candidate.run.id, contentHash: candidate.run.contentHash },
          comparison: {
            id: candidate.comparison.id,
            contentHash: candidate.comparison.contentHash,
          },
        },
        usage: finalAccounting.usage,
        quality: {
          baselinePassRate: candidate.comparison.baselinePassRate,
          candidatePassRate: candidate.comparison.candidatePassRate,
          adaptationBaselinePassRate:
            adaptation.run.passedCount / adaptation.run.attemptCount,
          adaptationCandidatePassRate:
            candidateAdaptation.summary.passedCount
              / candidateAdaptation.summary.attemptCount,
          adaptationCandidatePassed:
            candidateAdaptation.summary.passedCount
              === candidateAdaptation.summary.attemptCount,
          heldOutCandidatePassed:
            candidate.run.passedCount === candidate.run.attemptCount,
          passed:
            candidate.comparison.qualityPassed
            && candidateAdaptation.summary.passedCount
              === candidateAdaptation.summary.attemptCount
            && candidate.run.passedCount === candidate.run.attemptCount
            && infrastructureValid
            && terminalClassification !== "infrastructure_failure",
        },
        foregroundTokenDelta: candidate.comparison.foregroundTokenDelta,
        foregroundTokenDeltaPercent:
          candidate.comparison.foregroundTokenDeltaPercent,
        taskEfficiency,
        efficiency,
        budget: {
          maximumSpendUsd: budget.maximumSpendUsd,
          observedSpendUsd: budget.observedSpendUsd,
          enforced: true,
        },
        evidenceSnapshot: {
          id: frozenEvidence.id,
          contentHash: frozenEvidence.contentHash,
        },
        lineage,
        invalidReasons,
        attempts: finalAccounting.attempts,
        terminalClassification,
        profileGit: profileGit
          ? {
              ref: profileGit.ref,
              commit: profileGit.commit,
              baseCommit: profileGit.baseCommit,
            }
          : null,
      };
      const receipt = ModelEvaluationReceiptSchema.parse({
        ...receiptCore,
        contentHash: contentHash(receiptCore),
      });
      const completedAt = now();
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
    } catch (error) {
      const completedAt = now();
      const latestRun = await deps.store.getModelRun(modelRun.id) ?? modelRun;
      const cancelled = context.signal.aborted || latestRun.status === "cancelled";
      return deps.store.saveModelRun(ModelRunSchema.parse({
        ...latestRun,
        status: cancelled ? "cancelled" : "failed",
        failure: cancelled ? "Benchmark cancelled by operator." : safeError(error),
        completedAt,
        updatedAt: completedAt,
      }));
    }
  }

  return {
    reconcileInterrupted,
    cancel,
    resume,
    start,
    wait: async (modelRunId: string) =>
      activeRuns.get(modelRunId)?.execution ?? deps.store.getModelRun(modelRunId),
  };
}
