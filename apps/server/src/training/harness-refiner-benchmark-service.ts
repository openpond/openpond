import {
  CodexReasoningEffortSchema,
  ModelEvaluationReceiptSchema,
  ModelEvaluationStopReceiptSchema,
  ModelRunSchema,
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
  type HarnessRefinerExecutionPlanItem,
} from "./harness-refiner-benchmark-protocol.js";
import type { HostedTokenPricing } from "./hosted-token-pricing.js";
import { runHarnessRefinerBenchmarkRefinerStage } from "./harness-refiner-benchmark-refiner-stage.js";
import {
  checkpointAttempt,
  checkpointEvidenceSnapshot,
  classifyComparison,
  comparisonInvalidReasons,
  completedStage,
  createResultManifest,
  emptyEvaluationAccounting,
  ensureBaseVersion,
  frozenToolEvidence,
  loadCompletedBenchmarkStage,
  loadOrReconstructEvidenceSnapshot,
  modelVersionId,
  preserveProfileResult,
  releasedHarness,
  requireModelProject,
  requirePlanStage,
  safeError,
  updateProgress,
  writeManagedResult,
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
      (grader) => grader.kind === "model_judge" && grader.calibrationStatus !== "passed",
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
        stage: "baseline",
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
    if (
      run.status !== "failed"
      || run.evaluationProgress?.stage !== "refiner"
      || run.evaluationProgress.completedAttempts
        !== completedBeforeStage(run.evaluation.attemptPlan, "candidate_adaptation")
    ) {
      throw new Error(
        "Only a Harness Refiner run that failed after durable adaptation evidence can resume.",
      );
    }
    const project = await requireModelProject(deps.store, run.modelId, run.profileId);
    const prepared = await deps.store.saveModelRun(ModelRunSchema.parse({
      ...run,
      status: "running",
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
      const budget = new BenchmarkSpendBudget(
        input.maximumSpendUsd,
        resumeFromRefiner
          ? modelRun.evaluationProgress?.accounting?.observedSpendUsd ?? 0
          : 0,
      );
      let evidenceSnapshot = new BenchmarkEvidenceSnapshot();
      const observeStageAttempts = (
        stage: HarnessRefinerExecutionPlanItem["stage"],
        label: string,
      ) => {
        let completedInStage = 0;
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
      if (resumeFromRefiner) {
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
      await ensureBaseVersion({
        store: deps.store,
        project: context.project,
        modelRun,
        model: input.model,
        baseline: executedBaseline.attempts[0]!,
      });
      if (
        baseline.run.harnessRelease.id !== modelRun.harnessRelease.id
        || baseline.run.harnessRelease.contentHash !== modelRun.harnessRelease.contentHash
      ) {
        throw new Error("Baseline execution drifted from the admitted Harness release.");
      }

      await checkpointEvidenceSnapshot(
        deps.store,
        deps.storeDir,
        modelRun.id,
        evidenceSnapshot.manifest(),
      );

      await updateProgress(deps.store, modelRun.id, {
        stage: "adaptation",
        completedAttempts: completedBeforeStage(executionPlan, "adaptation"),
        totalAttempts,
      });

      await deps.store.setHarnessBackgroundReviewSettings({
        workspaceId: isolated.workspace.id,
        enabled: true,
        updatedAt: now(),
      });
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
      if (resumeFromRefiner) {
        const priorOutcomes = await deps.store.listHarnessImprovementArtifacts(
          isolated.workspace.id,
          "refiner_outcome",
          1_000,
        );
        const currentWorkspace = await deps.store.getHarnessWorkspace(isolated.workspace.id);
        const currentReleaseRef = currentWorkspace?.currentChannel.release;
        if (
          priorOutcomes.length > 0
          && currentReleaseRef
          && currentReleaseRef.contentHash === baseline.run.harnessRelease.contentHash
        ) {
          await deps.store.setHarnessBackgroundReviewSettings({
            workspaceId: isolated.workspace.id,
            enabled: false,
            updatedAt: now(),
          });
          const latestRun = await deps.store.getModelRun(modelRun.id) ?? modelRun;
          const accounting = latestRun.evaluationProgress?.accounting
            ?? emptyEvaluationAccounting();
          const frozenEvidence = evidenceSnapshot.manifest();
          const refinerStage = {
            id: `benchmark-refiner-${modelRun.id}`,
            contentHash: contentHash(priorOutcomes),
            outcomeCount: priorOutcomes.length,
          };
          const receiptCore = {
            schemaVersion: "openpond.modelEvaluationStopReceipt.v1" as const,
            benchmarkId: "harness-refiner",
            terminalClassification: "inconclusive" as const,
            stopReason: "candidate_harness_unchanged" as const,
            reason:
              "Refiner produced no changed Harness candidate. Candidate replay was skipped because no effect can be attributed to refinement.",
            stoppedAfter: "refiner" as const,
            baselineHarness: baseline.run.harnessRelease,
            candidateHarness: currentReleaseRef,
            refiner: refinerStage,
            usage: accounting.usage,
            budget: {
              maximumSpendUsd: budget.maximumSpendUsd,
              observedSpendUsd: accounting.observedSpendUsd,
              enforced: true,
            },
            evidenceSnapshot: {
              id: frozenEvidence.id,
              contentHash: frozenEvidence.contentHash,
            },
            attempts: accounting.attempts,
          };
          const receipt = ModelEvaluationStopReceiptSchema.parse({
            ...receiptCore,
            contentHash: contentHash(receiptCore),
          });
          const completedAt = now();
          return deps.store.saveModelRun(ModelRunSchema.parse({
            ...latestRun,
            status: "succeeded",
            receipt,
            failure: null,
            completedAt,
            updatedAt: completedAt,
          }));
        }
      }
      const {
        candidateRecord,
        candidateRuntime,
        refinerStage,
        lineage,
        frozenEvidence,
      } = await runHarnessRefinerBenchmarkRefinerStage({
        store: deps.store,
        storeDir: deps.storeDir,
        modelRun,
        model: input.model,
        taskset,
        baselineRuntime,
        adaptationAttempts,
        evidenceSnapshot,
        budget,
        admittedPricing,
        refinerStream: deps.refinerStream,
        signal: context.signal,
        now,
      });
      const harnessChanged =
        baseline.run.harnessRelease.contentHash
        !== candidateRecord.harnessRelease.contentHash;
      if (!harnessChanged || !lineage.valid) {
        const stopReason = harnessChanged
          ? "candidate_lineage_invalid" as const
          : "candidate_harness_unchanged" as const;
        const reason = harnessChanged
          ? "Refiner produced a candidate whose causal lineage did not validate. Candidate replay was skipped."
          : "Refiner produced no changed Harness candidate. Candidate replay was skipped because no effect can be attributed to refinement.";
        const latestRun = await deps.store.getModelRun(modelRun.id) ?? modelRun;
        const accounting = latestRun.evaluationProgress?.accounting
          ?? emptyEvaluationAccounting();
        const receiptCore = {
          schemaVersion: "openpond.modelEvaluationStopReceipt.v1" as const,
          benchmarkId: "harness-refiner",
          terminalClassification: "inconclusive" as const,
          stopReason,
          reason,
          stoppedAfter: "refiner" as const,
          baselineHarness: baseline.run.harnessRelease,
          candidateHarness: {
            id: candidateRecord.harnessRelease.id,
            contentHash: candidateRecord.harnessRelease.contentHash,
          },
          refiner: refinerStage,
          usage: accounting.usage,
          budget: {
            maximumSpendUsd: budget.maximumSpendUsd,
            observedSpendUsd: budget.observedSpendUsd,
            enforced: true,
          },
          evidenceSnapshot: {
            id: frozenEvidence.id,
            contentHash: frozenEvidence.contentHash,
          },
          attempts: accounting.attempts,
        };
        const receipt = ModelEvaluationStopReceiptSchema.parse({
          ...receiptCore,
          contentHash: contentHash(receiptCore),
        });
        const completedAt = now();
        return deps.store.saveModelRun(ModelRunSchema.parse({
          ...latestRun,
          status: "succeeded",
          receipt,
          failure: null,
          completedAt,
          updatedAt: completedAt,
        }));
      }
      if (resumeFromRefiner && !modelRun.evaluationProgress?.evidenceSnapshot) {
        throw new Error(
          "Candidate replay cannot resume because the interrupted run did not preserve its exact frozen evidence snapshot. Start a new run to preserve a valid causal comparison.",
        );
      }
      await updateProgress(deps.store, modelRun.id, {
        stage: "candidate_adaptation",
        completedAttempts: completedBeforeStage(executionPlan, "candidate_adaptation"),
        totalAttempts,
      });
      const candidateHarness = releasedHarness(
        candidateRuntime.release,
        candidateRuntime.instructionContext,
      );
      const candidateAdaptation = await deps.evaluation.executeBenchmark({
        tasksetId: taskset.id,
        phase: "candidate",
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        seeds: input.seeds,
        repetitions: input.repetitions,
        split: candidateAdaptationPlan.split as never,
        taskIds: candidateAdaptationPlan.taskIds,
        sampling: { maxOutputTokens: 4_096, temperature: 0, topP: 1 },
        releasedHarness: candidateHarness,
        hostedTokenPricing: admittedPricing,
        parentModelRunId: modelRun.id,
        signal: context.signal,
        toolEvidence: frozenToolEvidence(evidenceSnapshot, "replay", "adaptation"),
        onAttemptComplete: observeStageAttempts(
          "candidate_adaptation",
          "candidate adaptation replay",
        ),
      });
      if (!candidateAdaptation.comparison) {
        throw new Error("Adaptation replay comparison was not produced.");
      }
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
        candidateAdaptation: candidateAdaptation.run,
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
        harnessChanged:
          baseline.run.harnessRelease.contentHash
          !== candidate.run.harnessRelease.contentHash,
        candidateAdaptation: candidateAdaptation.run,
        lineageValid: lineage.valid,
        infrastructureValid,
      });
      const invalidReasons = comparisonInvalidReasons({
        baseline: baseline.run,
        adaptation: adaptation.run,
        candidateAdaptation: candidateAdaptation.run,
        candidate: candidate.run,
        harnessChanged:
          baseline.run.harnessRelease.contentHash
          !== candidate.run.harnessRelease.contentHash,
        lineageValid: lineage.valid,
        infrastructureValid,
      });
      const finalRunCheckpoint = await deps.store.getModelRun(modelRun.id) ?? modelRun;
      const finalAccounting = finalRunCheckpoint.evaluationProgress?.accounting
        ?? emptyEvaluationAccounting();
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
            id: candidateAdaptation.run.id,
            contentHash: candidateAdaptation.run.contentHash,
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
            candidateAdaptation.run.passedCount / candidateAdaptation.run.attemptCount,
          adaptationCandidatePassed:
            candidateAdaptation.run.passedCount === candidateAdaptation.run.attemptCount,
          heldOutCandidatePassed:
            candidate.run.passedCount === candidate.run.attemptCount,
          passed:
            candidate.comparison.qualityPassed
            && candidateAdaptation.run.passedCount === candidateAdaptation.run.attemptCount
            && candidate.run.passedCount === candidate.run.attemptCount
            && infrastructureValid
            && terminalClassification !== "infrastructure_failure",
        },
        foregroundTokenDelta: candidate.comparison.foregroundTokenDelta,
        foregroundTokenDeltaPercent:
          candidate.comparison.foregroundTokenDeltaPercent,
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
