import { promises as fs } from "node:fs";
import path from "node:path";

import {
  ModelEvaluationReceiptSchema,
  ModelRunSchema,
  ModelVersionSchema,
  TurnSchema,
  type ChatModelRef,
  type CodexReasoningEffort,
  type ModelProject,
  type ModelRun,
  type OpenPondProfileState,
} from "@openpond/contracts";
import {
  aggregateEvaluationReceipts,
  type BenchmarkComparison,
  type BenchmarkRunSummary,
} from "@openpond/evals";
import {
  contentHash,
  type HarnessRefinerMessage,
} from "@openpond/harness";
import {
  commitProfileBenchmarkRef,
  type ProfileBenchmarkGitReceipt,
} from "@openpond/cloud/profile/profile-git";

import type { SqliteStore } from "../store/store.js";
import {
  forkLocalHarnessWorkspaceFromRelease,
  localHarnessWorkspacePaths,
} from "../harness/local-harness-workspace-service.js";
import { resolveSelectedLocalHarnessRelease } from "../harness/local-harness-selection.js";
import { loadLocalHarnessRuntimeFromRelease } from "../harness/local-harness-skill-runtime.js";
import { ensureLocalHarnessRunOverlay } from "../harness/local-harness-run-overlay.js";
import { recordLocalHarnessImprovementBoundary } from "../harness/local-harness-improvement-observer.js";
import { runLocalHarnessRefinerWorker } from "../harness/local-harness-refiner-worker.js";
import type { createTaskEvaluationService } from "./evaluation-service.js";
import type { createBenchmarkTasksetService } from "./benchmark-tasksets.js";
import { event } from "../utils.js";
import { normalizeModelUsageTokens } from "../runtime/model-usage-normalization.js";

type Evaluation = ReturnType<typeof createTaskEvaluationService>;
type EvaluationAttempt = Awaited<ReturnType<Evaluation["execute"]>>;
type BenchmarkTasksets = ReturnType<typeof createBenchmarkTasksetService>;

type BenchmarkRefinerModelStream = (input: {
  messages: HarnessRefinerMessage[];
  signal: AbortSignal;
}) => AsyncIterable<{ text?: string; usage?: unknown; costUsd?: number }>;

type StartBenchmarkInput = {
  modelId: string;
  profileId: string;
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | "none" | null;
  mode: "smoke" | "full";
  seeds: number[];
  repetitions: number;
  maximumSpendUsd: number;
};

type ManagedResultManifest = {
  schemaVersion: "openpond.harnessRefinerBenchmarkResult.v1";
  id: string;
  modelRunId: string;
  benchmarkId: "harness-refiner";
  mode: "smoke" | "full";
  model: ChatModelRef;
  reasoningEffort: string | null;
  tasksetRelease: { id: string; contentHash: string };
  baseline: BenchmarkRunSummary;
  adaptation: { id: string; contentHash: string; attemptCount: number };
  refiner: { id: string; contentHash: string; outcomeCount: number };
  candidate: BenchmarkRunSummary;
  comparison: BenchmarkComparison;
  harness: {
    baseline: { id: string; contentHash: string };
    candidate: { id: string; contentHash: string };
  };
  createdAt: string;
  contentHash: string;
};

const activeRuns = new Map<string, Promise<ModelRun>>();

export function createHarnessRefinerBenchmarkService(deps: {
  store: SqliteStore;
  storeDir: string;
  evaluation: Evaluation;
  benchmarkTasksets: BenchmarkTasksets;
  loadProfileState: () => Promise<OpenPondProfileState>;
  refinerStream: BenchmarkRefinerModelStream;
  now?: () => string;
}) {
  const now = deps.now ?? (() => new Date().toISOString());

  async function start(input: StartBenchmarkInput): Promise<ModelRun> {
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
    const startedAt = now();
    const id = `model_run_${contentHash({
      modelId: project.id,
      taskset: taskset.contentHash,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      mode: input.mode,
      seeds: input.seeds,
      repetitions: input.repetitions,
      startedAt,
    }).slice(0, 24)}`;
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
      harnessRelease: null,
      quote: null,
      evaluation: {
        benchmarkId: "harness-refiner",
        mode: input.mode,
        model: input.model,
        upstreamModel: benchmarkUpstreamModel(input.model),
        reasoningEffort: input.reasoningEffort,
        seeds: input.seeds,
        repetitions: input.repetitions,
        maximumSpendUsd: input.maximumSpendUsd,
      },
      evaluationProgress: {
        stage: "baseline",
        completedAttempts: 0,
        totalAttempts: input.mode === "smoke" ? 6 : 30,
      },
      reward: null,
      receipt: null,
      adapterArtifactLineageId: null,
      failure: null,
      startedAt,
      completedAt: null,
      updatedAt: startedAt,
    }));
    const execution = executePass({ input, project, modelRun: prepared })
      .finally(() => activeRuns.delete(id));
    activeRuns.set(id, execution);
    void execution.catch(() => undefined);
    return prepared;
  }

  async function reconcileInterrupted(): Promise<number> {
    const interrupted = (await deps.store.listModelRuns()).filter(
      (run) => run.kind === "evaluation" && run.status === "running",
    );
    const completedAt = now();
    for (const run of interrupted) {
      await deps.store.saveModelRun(ModelRunSchema.parse({
        ...run,
        status: "failed",
        failure:
          "Benchmark execution was interrupted when the app server stopped. Start a new run to preserve a complete causal record.",
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
  }): Promise<ModelRun> {
    const { input, modelRun } = context;
    try {
      const selected = await resolveSelectedLocalHarnessRelease(deps.store);
      if (!selected) throw new Error("A selected local Harness is required.");
      const isolated = await forkLocalHarnessWorkspaceFromRelease({
        store: deps.store,
        storeDir: deps.storeDir,
        id: `benchmark-${modelRun.id}`,
        ownerId: `benchmark:${modelRun.id}`,
        name: `Harness Refiner ${modelRun.id}`,
        sourceRelease: {
          id: selected.harnessRelease.id,
          contentHash: selected.harnessRelease.contentHash,
        },
        now,
      });
      await deps.store.setHarnessBackgroundReviewSettings({
        workspaceId: isolated.workspace.id,
        enabled: false,
        updatedAt: now(),
      });
      const taskset = await deps.store.getTaskset(modelRun.taskset.id);
      if (!taskset?.benchmark) throw new Error("Harness Refiner Taskset changed before execution.");
      const evaluationTaskIds = taskset.tasks
        .filter((task) => task.split === taskset.benchmark!.evaluationSplit)
        .map((task) => task.id);
      const adaptationTaskIds = taskset.tasks
        .filter((task) => task.split === taskset.benchmark!.adaptationSplit)
        .map((task) => task.id);
      const selectedEvaluationIds = input.mode === "smoke"
        ? selectSmokeTaskIds(taskset.tasks, taskset.benchmark.evaluationSplit)
        : evaluationTaskIds;
      const selectedAdaptationIds = input.mode === "smoke"
        ? selectSmokeTaskIds(taskset.tasks, taskset.benchmark.adaptationSplit)
        : adaptationTaskIds;
      const baselineRuntime = await loadLocalHarnessRuntimeFromRelease({
        workspace: isolated.workspace,
        release: isolated.release,
      });
      const baselineHarness = releasedHarness(
        baselineRuntime.release,
        baselineRuntime.instructionContext,
      );
      const baseline = await deps.evaluation.executeBenchmark({
        tasksetId: taskset.id,
        phase: "baseline",
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        seeds: input.seeds,
        repetitions: input.repetitions,
        taskIds: selectedEvaluationIds,
        sampling: { maxOutputTokens: 4_096, temperature: 0, topP: 1 },
        releasedHarness: baselineHarness,
      });

      await updateProgress(deps.store, modelRun.id, {
        stage: "adaptation",
        completedAttempts: selectedEvaluationIds.length
          * input.seeds.length
          * input.repetitions,
        totalAttempts:
          (selectedEvaluationIds.length * 2 + selectedAdaptationIds.length)
          * input.seeds.length
          * input.repetitions,
      });

      await deps.store.setHarnessBackgroundReviewSettings({
        workspaceId: isolated.workspace.id,
        enabled: true,
        updatedAt: now(),
      });
      const adaptationAttempts = [];
      const adaptationAdmittedAt = now();
      for (const taskId of selectedAdaptationIds) {
        for (const seed of input.seeds) {
          for (let repetition = 0; repetition < input.repetitions; repetition += 1) {
            adaptationAttempts.push(await deps.evaluation.execute({
              tasksetId: taskset.id,
              taskId,
              model: input.model,
              reasoningEffort: input.reasoningEffort,
              seed,
              attempt: repetition,
              sampling: { maxOutputTokens: 4_096, temperature: 0, topP: 1 },
              releasedHarness: baselineHarness,
              admittedAt: adaptationAdmittedAt,
            }));
          }
        }
      }
      const adaptationManifest = adaptationAttempts[0]?.portable.runManifest;
      if (!adaptationManifest) throw new Error("Adaptation produced no attempts.");
      const adaptationReceipts = adaptationAttempts.map((attempt) => attempt.portable.receipt);
      const adaptation = aggregateEvaluationReceipts({
        id: `benchmark-adaptation-${contentHash(adaptationReceipts.map((item) => item.contentHash)).slice(0, 24)}`,
        manifest: adaptationManifest,
        receipts: adaptationReceipts,
        metadata: {
          sourceTasksetId: taskset.id,
          modelRunId: modelRun.id,
          benchmarkId: "harness-refiner",
        },
      });
      await deps.store.saveEvaluationResult({
        tasksetId: taskset.id,
        kind: "adaptation",
        result: adaptation,
        createdAt: now(),
      });
      await updateProgress(deps.store, modelRun.id, {
        stage: "refiner",
        completedAttempts:
          (selectedEvaluationIds.length + selectedAdaptationIds.length)
          * input.seeds.length
          * input.repetitions,
        totalAttempts:
          (selectedEvaluationIds.length * 2 + selectedAdaptationIds.length)
          * input.seeds.length
          * input.repetitions,
      });
      const queuedTriggers = [];
      const refinerUsage = emptyUsageCategory();
      for (const result of adaptationAttempts) {
        const attempt = result.attempt;
        const sessionId = stringMetadata(attempt.metadata, "sessionId");
        const turnId = stringMetadata(attempt.metadata, "turnId");
        if (!sessionId || !turnId) continue;
        const session = await deps.store.getSession(sessionId);
        if (!session) continue;
        const overlay = await ensureLocalHarnessRunOverlay({
          store: deps.store,
          runId: session.id,
          workspace: baselineRuntime.workspace,
          harnessRelease: {
            id: baselineRuntime.release.harnessRelease.id,
            contentHash: baselineRuntime.release.harnessRelease.contentHash,
          },
          admittedAt: attempt.startedAt,
        });
        const task = taskset.tasks.find((candidate) => candidate.id === attempt.taskId);
        if (!task) continue;
        const turn = TurnSchema.parse({
          id: turnId,
          sessionId: session.id,
          providerTurnId: null,
          modelRef: input.model,
          prompt: taskPrompt(task),
          startedAt: attempt.startedAt,
          completedAt: attempt.completedAt,
          status: "completed",
          error: null,
          metadata: {
            automatedTasksetWorkAttempt: true,
            benchmarkId: "harness-refiner",
            modelRunId: modelRun.id,
            attemptId: attempt.id,
          },
          harnessSnapshot: {
            schemaVersion: "openpond.harnessTurnSnapshot.v1",
            workspaceId: baselineRuntime.workspace.id,
            workspaceRevision: baselineRuntime.workspace.revision,
            sourceRevision: baselineRuntime.workspace.sourceRevision,
            channelName: baselineRuntime.workspace.currentChannel.name,
            channelRevision: baselineRuntime.workspace.currentChannel.revision,
            harnessRelease: overlay.baseHarnessRelease,
            overlay: {
              id: overlay.id,
              revision: overlay.revision,
              contentHash: overlay.contentHash,
            },
          },
        });
        if (!(await deps.store.getTurn(turn.id))) await deps.store.insertTurn(turn);
        const assistantOutput = attempt.output.text;
        if (typeof assistantOutput === "string" && assistantOutput.trim()) {
          await deps.store.appendRuntimeEvent(event({
            sessionId: session.id,
            turnId: turn.id,
            name: "assistant.delta",
            source: "server",
            appId: session.appId,
            status: "completed",
            output: assistantOutput,
          }));
        }
        const gradeEvidence = JSON.stringify({
          schemaVersion: result.grade.schemaVersion,
          id: result.grade.id,
          passed: result.grade.passed,
          score: result.grade.score,
          failureClass: result.grade.failureClass,
          rewardEligible: result.grade.rewardEligible,
          feedback: result.grade.feedback,
          evaluationCriteria: task.expectedOutput,
          attempt: {
            status: result.attempt.infrastructureError
              ? "infrastructure_failure"
              : "completed",
            infrastructureError: result.attempt.infrastructureError,
            outputPresent:
              typeof result.attempt.output.text === "string"
              && result.attempt.output.text.trim().length > 0,
            artifactCount: result.artifacts.length,
            runtimeEventCount: result.attempt.runtimeEventRefs.length,
            latencyMs: result.attempt.latencyMs,
            usage: attemptUsageSummary(result.attempt.metadata.usage),
          },
        });
        await deps.store.appendRuntimeEvent(event({
          sessionId: session.id,
          turnId: turn.id,
          name: "diagnostic",
          source: "server",
          appId: session.appId,
          action: "taskset_grade",
          status: result.grade.passed ? "completed" : "failed",
          output: gradeEvidence,
          error: result.grade.passed ? undefined : gradeEvidence,
          data: {
            result: {
              output: gradeEvidence,
              passed: result.grade.passed,
              score: result.grade.score,
            },
          },
        }));
        const detection = await recordLocalHarnessImprovementBoundary({
          store: deps.store,
          session,
          turn,
          boundaryKind: "turn_completed",
          now,
        });
        if (detection?.trigger.decision === "queue_refiner") {
          queuedTriggers.push(detection.trigger);
        }
      }
      for (const trigger of queuedTriggers) {
        await runLocalHarnessRefinerWorker({
          store: deps.store,
          storeDir: deps.storeDir,
          trigger,
          stream: async function* (streamInput) {
            for await (const delta of deps.refinerStream(streamInput)) {
              if (delta.usage !== undefined) {
                addUsage(refinerUsage, delta.usage, delta.costUsd);
              }
              if (delta.text) yield { text: delta.text };
            }
          },
          signal: new AbortController().signal,
          now,
        });
      }
      const candidateWorkspace = await deps.store.getHarnessWorkspace(isolated.workspace.id);
      if (!candidateWorkspace?.currentChannel.release) {
        throw new Error("Isolated Harness candidate is unavailable.");
      }
      const candidateRecord = await deps.store.getHarnessReleaseRecord(
        candidateWorkspace.currentChannel.release.contentHash,
      );
      if (!candidateRecord) throw new Error("Isolated Harness candidate release is unavailable.");
      const candidateRuntime = await loadLocalHarnessRuntimeFromRelease({
        workspace: candidateWorkspace,
        release: candidateRecord,
      });
      await deps.store.setHarnessBackgroundReviewSettings({
        workspaceId: isolated.workspace.id,
        enabled: false,
        updatedAt: now(),
      });
      await updateProgress(deps.store, modelRun.id, {
        stage: "candidate",
        completedAttempts:
          (selectedEvaluationIds.length + selectedAdaptationIds.length)
          * input.seeds.length
          * input.repetitions,
        totalAttempts:
          (selectedEvaluationIds.length * 2 + selectedAdaptationIds.length)
          * input.seeds.length
          * input.repetitions,
      });
      const candidate = await deps.evaluation.executeBenchmark({
        tasksetId: taskset.id,
        phase: "candidate",
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        seeds: input.seeds,
        repetitions: input.repetitions,
        taskIds: selectedEvaluationIds,
        sampling: { maxOutputTokens: 4_096, temperature: 0, topP: 1 },
        releasedHarness: releasedHarness(
          candidateRuntime.release,
          candidateRuntime.instructionContext,
        ),
      });
      if (!candidate.comparison) throw new Error("Paired benchmark comparison was not produced.");
      await updateProgress(deps.store, modelRun.id, {
        stage: "comparison",
        completedAttempts:
          (selectedEvaluationIds.length * 2 + selectedAdaptationIds.length)
          * input.seeds.length
          * input.repetitions,
        totalAttempts:
          (selectedEvaluationIds.length * 2 + selectedAdaptationIds.length)
          * input.seeds.length
          * input.repetitions,
      });
      const outcomes = await deps.store.listHarnessImprovementArtifacts(
        isolated.workspace.id,
        "refiner_outcome",
        1_000,
      );
      const refinerStage = {
        id: `benchmark-refiner-${modelRun.id}`,
        contentHash: contentHash(outcomes),
        outcomeCount: outcomes.length,
      };
      const manifest = createResultManifest({
        modelRunId: modelRun.id,
        mode: input.mode,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        baseline: baseline.run,
        adaptation: {
          id: adaptation.id,
          contentHash: adaptation.contentHash,
          attemptCount: adaptation.attemptCount,
        },
        refiner: refinerStage,
        candidate: candidate.run,
        comparison: candidate.comparison,
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
      const terminalClassification = classifyComparison({
        comparison: candidate.comparison,
        baseline: baseline.run,
        candidate: candidate.run,
        harnessChanged:
          baseline.run.harnessRelease.contentHash
          !== candidate.run.harnessRelease.contentHash,
      });
      const graderUsage = deps.evaluation.consumeGraderUsage([
        ...baseline.attempts.map((attempt) => attempt.attempt.id),
        ...adaptationAttempts.map((attempt) => attempt.attempt.id),
        ...candidate.attempts.map((attempt) => attempt.attempt.id),
      ]);
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
          adaptation: { id: adaptation.id, contentHash: adaptation.contentHash },
          refiner: { id: refinerStage.id, contentHash: refinerStage.contentHash },
          candidate: { id: candidate.run.id, contentHash: candidate.run.contentHash },
          comparison: {
            id: candidate.comparison.id,
            contentHash: candidate.comparison.contentHash,
          },
        },
        usage: {
          baseline: usageCategory(baseline.run),
          candidate: usageCategory(candidate.run),
          refiner: refinerUsage,
          grader: graderUsage,
        },
        quality: {
          baselinePassRate: candidate.comparison.baselinePassRate,
          candidatePassRate: candidate.comparison.candidatePassRate,
          passed:
            candidate.comparison.qualityPassed
            && terminalClassification !== "infrastructure_failure",
        },
        foregroundTokenDelta: candidate.comparison.foregroundTokenDelta,
        foregroundTokenDeltaPercent:
          candidate.comparison.foregroundTokenDeltaPercent,
        attempts: [
          ...modelEvaluationAttempts("baseline", baseline.attempts),
          ...modelEvaluationAttempts("adaptation", adaptationAttempts),
          ...modelEvaluationAttempts("candidate", candidate.attempts),
        ],
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
      const totalAttempts =
        baseline.run.attemptCount
        + adaptation.attemptCount
        + candidate.run.attemptCount;
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
      return deps.store.saveModelRun(ModelRunSchema.parse({
        ...latestRun,
        status: "failed",
        failure: safeError(error),
        completedAt,
        updatedAt: completedAt,
      }));
    }
  }

  return {
    reconcileInterrupted,
    start,
    wait: async (modelRunId: string) =>
      activeRuns.get(modelRunId) ?? deps.store.getModelRun(modelRunId),
  };
}

function releasedHarness(record: {
  agentSnapshot: import("@openpond/harness").AgentSnapshot;
  harnessRelease: import("@openpond/harness").HarnessRelease;
}, instructionContext?: string) {
  return {
    agentSnapshot: record.agentSnapshot,
    harnessRelease: record.harnessRelease,
    instructionContext,
  };
}

function stringMetadata(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function taskPrompt(task: { input: Record<string, unknown> }): string {
  if (typeof task.input.prompt === "string" && task.input.prompt.trim()) {
    return task.input.prompt;
  }
  const messages = Array.isArray(task.input.messages) ? task.input.messages : [];
  return messages
    .flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const content = (message as Record<string, unknown>).content;
      return typeof content === "string" && content.trim() ? [content] : [];
    })
    .join("\n\n");
}

export function benchmarkUpstreamModel(model: ChatModelRef): {
  providerId: string;
  modelId: string;
  revision: string | null;
} {
  if (model.providerId !== "openpond") {
    return { providerId: model.providerId, modelId: model.modelId, revision: null };
  }
  if (model.modelId === "openpond-chat") {
    return { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null };
  }
  if (model.modelId === "deepseek-v4-flash") {
    return { providerId: "deepseek", modelId: "deepseek-v4-flash", revision: null };
  }
  if (model.modelId.startsWith("accounts/fireworks/models/")) {
    return { providerId: "fireworks", modelId: model.modelId, revision: null };
  }
  return { providerId: "openpond", modelId: model.modelId, revision: null };
}

async function requireModelProject(
  store: SqliteStore,
  modelId: string,
  profileId: string,
) {
  const project = await store.getModelProject(modelId);
  if (!project || project.profileId !== profileId) {
    throw new Error("A Model in the active Profile is required.");
  }
  return project;
}

async function updateProgress(
  store: SqliteStore,
  modelRunId: string,
  progress: NonNullable<ModelRun["evaluationProgress"]>,
) {
  const run = await store.getModelRun(modelRunId);
  if (!run || run.kind !== "evaluation") {
    throw new Error(`Evaluation Model Run ${modelRunId} is unavailable.`);
  }
  return store.saveModelRun(ModelRunSchema.parse({
    ...run,
    evaluationProgress: progress,
    updatedAt: new Date().toISOString(),
  }));
}

function createResultManifest(
  input: Omit<ManagedResultManifest, "schemaVersion" | "id" | "benchmarkId" | "tasksetRelease" | "harness" | "contentHash">,
): ManagedResultManifest {
  const core = {
    schemaVersion: "openpond.harnessRefinerBenchmarkResult.v1" as const,
    id: `benchmark-result-${input.modelRunId}`,
    modelRunId: input.modelRunId,
    benchmarkId: "harness-refiner" as const,
    mode: input.mode,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    tasksetRelease: input.baseline.tasksetRelease,
    baseline: input.baseline,
    adaptation: input.adaptation,
    refiner: input.refiner,
    candidate: input.candidate,
    comparison: input.comparison,
    harness: {
      baseline: input.baseline.harnessRelease,
      candidate: input.candidate.harnessRelease,
    },
    createdAt: input.createdAt,
  };
  return { ...core, contentHash: contentHash(core) };
}

async function writeManagedResult(
  storeDir: string,
  modelRunId: string,
  manifest: ManagedResultManifest,
) {
  const root = path.join(storeDir, "training", "model-runs", modelRunId, "benchmark");
  await fs.mkdir(root, { recursive: true });
  const filePath = path.join(root, `${manifest.contentHash}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path.relative(storeDir, filePath).replaceAll(path.sep, "/");
}

async function preserveProfileResult(input: {
  profile: OpenPondProfileState;
  modelRunId: string;
  workspaceId: string;
  storeDir: string;
  manifest: ManagedResultManifest;
}): Promise<ProfileBenchmarkGitReceipt | null> {
  if (
    input.profile.mode !== "local"
    || !input.profile.repoPath
    || !input.profile.git?.head
  ) return null;
  const sourceRoot = localHarnessWorkspacePaths(
    input.storeDir,
    input.workspaceId,
  ).source;
  const sourceFiles = await listFiles(sourceRoot);
  const prefix = `benchmarks/harness-refiner/runs/${input.modelRunId}`;
  return commitProfileBenchmarkRef({
    repoPath: input.profile.repoPath,
    runId: input.modelRunId,
    baseCommit: input.profile.git.head,
    message: `Preserve Harness Refiner benchmark ${input.modelRunId}`,
    files: [
      {
        path: `${prefix}/result.json`,
        contents: `${JSON.stringify(input.manifest, null, 2)}\n`,
      },
      ...await Promise.all(sourceFiles.map(async (relativePath) => ({
        path: `${prefix}/candidate-harness/${relativePath}`,
        contents: await fs.readFile(path.join(sourceRoot, ...relativePath.split("/"))),
      }))),
    ],
  });
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, ...relative.split("/").filter(Boolean));
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, next));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

async function ensureBaseVersion(input: {
  store: SqliteStore;
  project: ModelProject;
  modelRun: ModelRun;
  model: ChatModelRef;
  baseline: Awaited<ReturnType<Evaluation["executeBenchmark"]>>["attempts"][number];
}) {
  const existing = await input.store.getModelVersion(input.modelRun.modelVersionId);
  if (existing) return existing;
  const runManifest = input.baseline.portable.runManifest;
  const tasksetRelease = input.baseline.portable.tasksetRelease;
  const graph = {
    resolvedBundleHash: contentHash({
      tasksetRelease: tasksetRelease.contentHash,
      runManifest: runManifest.contentHash,
    }),
    profileRelease: {
      id: `profile-release-${input.modelRun.profileId}`,
      revision: 1,
      contentHash: contentHash({ profileId: input.modelRun.profileId }),
    },
    harnessRelease: runManifest.harnessRelease,
    agentRelease: {
      id: input.baseline.portable.agentSnapshot.id,
      contentHash: input.baseline.portable.agentSnapshot.contentHash,
    },
    grader: {
      id: `grader-${tasksetRelease.id}`,
      contentHash: contentHash(tasksetRelease.graders),
    },
  };
  const core = {
    schemaVersion: "openpond.modelVersion.v1" as const,
    id: input.modelRun.modelVersionId,
    modelId: input.project.id,
    profileId: input.project.profileId,
    version: 0,
    kind: "base_reference" as const,
    status: "available" as const,
    baseModel: {
      schemaVersion: "openpond.baseModelPreference.v1" as const,
      modelId: `${input.model.providerId}/${input.model.modelId}`,
      revision: runManifest.model.revision,
      tokenizerRevision: runManifest.model.tokenizerRevision,
      chatTemplateHash: runManifest.model.chatTemplateHash,
      modelAssetId: null,
      source: "managed" as const,
    },
    taskset: input.modelRun.taskset,
    releaseGraph: graph,
    artifactLineageId: null,
    adapterStatus: "not_trained" as const,
    createdAt: input.modelRun.startedAt,
  };
  return input.store.saveModelVersion(ModelVersionSchema.parse({
    ...core,
    contentHash: contentHash(core),
  }));
}

function usageCategory(run: BenchmarkRunSummary) {
  return {
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    totalTokens: run.usage.totalTokens,
    costUsd: run.costUsd,
  };
}

function modelEvaluationAttempts(
  phase: "baseline" | "adaptation" | "candidate",
  results: EvaluationAttempt[],
) {
  return results.map((result) => {
    const usage = emptyUsageCategory();
    const rawUsage = result.attempt.metadata.usage;
    for (const item of Array.isArray(rawUsage) ? rawUsage : [rawUsage]) {
      addUsage(usage, item);
    }
    return {
      phase,
      taskId: result.attempt.taskId,
      attemptId: result.attempt.id,
      sessionId: stringMetadata(result.attempt.metadata, "sessionId"),
      turnId: stringMetadata(result.attempt.metadata, "turnId"),
      passed: result.grade.passed,
      score: result.grade.score,
      failureClass: result.grade.failureClass,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      latencyMs: result.attempt.latencyMs,
      costUsd: result.attempt.costUsd,
      startedAt: result.attempt.startedAt,
    };
  });
}

function attemptUsageSummary(rawUsage: unknown) {
  const usage = emptyUsageCategory();
  for (const item of Array.isArray(rawUsage) ? rawUsage : [rawUsage]) {
    addUsage(usage, item);
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

type EvaluationUsageCategory = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
};

function emptyUsageCategory(): EvaluationUsageCategory {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null };
}

function addUsage(
  category: EvaluationUsageCategory,
  usage: unknown,
  costUsd?: number,
) {
  const normalized = normalizeModelUsageTokens(usage);
  category.inputTokens += normalized.promptTokens ?? 0;
  category.outputTokens += normalized.completionTokens ?? 0;
  category.totalTokens += normalized.totalTokens ?? 0;
  if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0) {
    category.costUsd = (category.costUsd ?? 0) + costUsd;
  }
}

export function selectSmokeTaskIds(
  tasks: Array<{ id: string; split: string; tags: string[] }>,
  split: string,
): string[] {
  const candidates = tasks.filter((task) => task.split === split);
  const artifact = candidates.find((task) => task.tags.includes("artifact-verification"));
  const research = candidates.find((task) => task.tags.includes("research-efficiency"));
  const selected = [artifact, research].filter(
    (task): task is { id: string; split: string; tags: string[] } => Boolean(task),
  );
  if (selected.length !== 2) {
    throw new Error(`Harness Refiner smoke cohort requires artifact and research cases for ${split}.`);
  }
  return selected.map((task) => task.id);
}

function classifyComparison(input: {
  comparison: BenchmarkComparison;
  baseline: BenchmarkRunSummary;
  candidate: BenchmarkRunSummary;
  harnessChanged: boolean;
}): "improved" | "no_improvement" | "regressed" | "inconclusive" | "infrastructure_failure" {
  if (
    input.baseline.terminalCount !== input.baseline.attemptCount
    || input.candidate.terminalCount !== input.candidate.attemptCount
  ) return "infrastructure_failure";
  if (!input.harnessChanged) return "inconclusive";
  if (!input.comparison.qualityPassed) return "regressed";
  return input.comparison.improved ? "improved" : "no_improvement";
}

function modelVersionId(modelId: string) {
  return `model_version_${contentHash({ modelId, version: 0 }).slice(0, 24)}`;
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 5_000) || "Harness Refiner benchmark failed.";
}
