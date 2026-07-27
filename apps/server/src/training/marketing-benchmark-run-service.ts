import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  MarketingBenchmarkRunSchema,
  TrainingArtifactSchema,
  type MarketingBenchmarkArm,
  type MarketingBenchmarkRun,
  type MarketingBenchmarkSpecification,
  type MarketingBenchmarkTrajectoryReceipt,
  type ModelArtifactLineage,
} from "@openpond/contracts";
import {
  canonicalJson,
  contentHash,
  sha256,
  type BaselineAttemptRunner,
} from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";
import {
  resolvePrimeGrpoBaseProfile,
} from "./prime-grpo-base-profiles.js";
import type {
  createPrimeEvaluationSessionService,
} from "./prime-evaluation-session.js";
import {
  allocatePrimeEvaluationCost,
  buildMarketingBenchmarkReceipt,
  successfulMarketingBenchmarkTrajectory,
} from "./marketing-benchmark-results.js";

type PrimeEvaluationService = ReturnType<
  typeof createPrimeEvaluationSessionService
>;

export function createMarketingBenchmarkRunService(input: {
  store: SqliteStore;
  storeDir: string;
  runAttempt: BaselineAttemptRunner;
  primeEvaluation: PrimeEvaluationService;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const active = new Map<string, {
    controller: AbortController;
    operation: Promise<void>;
  }>();

  async function start(startInput: {
    specificationId: string;
    candidateModelVersionId: string;
  }): Promise<MarketingBenchmarkRun> {
    const context = await resolveContext(startInput);
    const existing = (
      await input.store.listMarketingBenchmarkRuns({
        tasksetId: context.specification.taskset.id,
      })
    ).find(
      (run) =>
        run.specificationId ===
          context.specification.id
        && run.candidateModelVersionId
          === context.candidate.id
        && (
          run.status === "prepared"
          || run.status === "running"
          || run.status === "succeeded"
        ),
    );
    if (existing) return existing;
    const createdAt = timestamp();
    const id = `marketing_benchmark_run_${contentHash([
      context.specification.id,
      context.candidate.id,
      createdAt,
      randomUUID(),
    ]).slice(0, 24)}`;
    const run = await input.store.saveMarketingBenchmarkRun(
      MarketingBenchmarkRunSchema.parse({
        schemaVersion:
          "openpond.marketingBenchmarkRun.v1",
        id,
        profileId: context.specification.profileId,
        tasksetId: context.specification.taskset.id,
        specificationId: context.specification.id,
        specificationHash:
          context.specification.contentHash,
        candidateModelVersionId:
          context.candidate.id,
        status: "prepared",
        progress: {
          completedTrajectories: 0,
          totalTrajectories: 96,
        },
        receipt: null,
        error: null,
        createdAt,
        startedAt: null,
        completedAt: null,
        updatedAt: createdAt,
      }),
    );
    launch(run, context);
    return run;
  }

  async function cancel(
    runId: string,
  ): Promise<MarketingBenchmarkRun> {
    const run = await requireRun(runId);
    if (
      run.status !== "prepared"
      && run.status !== "running"
    ) {
      return run;
    }
    active.get(runId)?.controller.abort(
      new Error("Marketing benchmark cancelled."),
    );
    const completedAt = timestamp();
    return input.store.saveMarketingBenchmarkRun({
      ...run,
      status: "cancelled",
      error: "Marketing benchmark cancelled.",
      completedAt,
      updatedAt: completedAt,
    });
  }

  async function reconcile(): Promise<{
    failedRunIds: string[];
  }> {
    const runs = await input.store.listMarketingBenchmarkRuns();
    const failedRunIds: string[] = [];
    for (const run of runs) {
      if (
        run.status !== "prepared"
        && run.status !== "running"
      ) {
        continue;
      }
      const completedAt = timestamp();
      await input.store.saveMarketingBenchmarkRun({
        ...run,
        status: "failed",
        error:
          "The server restarted before the frozen benchmark completed; the Prime evaluation cleanup ledger was reconciled.",
        completedAt,
        updatedAt: completedAt,
      });
      failedRunIds.push(run.id);
    }
    return { failedRunIds };
  }

  function launch(
    run: MarketingBenchmarkRun,
    context: Awaited<ReturnType<typeof resolveContext>>,
  ): void {
    const controller = new AbortController();
    const operation =
      execute(run, context, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        active.delete(run.id);
      });
    active.set(run.id, { controller, operation });
  }

  async function close(): Promise<void> {
    const operations = [...active.values()];
    for (const entry of operations) {
      entry.controller.abort(
        new Error(
          "OpenPond is shutting down during the marketing benchmark.",
        ),
      );
    }
    await Promise.allSettled(
      operations.map((entry) => entry.operation),
    );
  }

  async function execute(
    initialRun: MarketingBenchmarkRun,
    context: Awaited<ReturnType<typeof resolveContext>>,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = timestamp();
    let run = await input.store.saveMarketingBenchmarkRun({
      ...initialRun,
      status: "running",
      startedAt,
      updatedAt: startedAt,
    });
    let primeSession:
      | Awaited<ReturnType<PrimeEvaluationService["start"]>>
      | null = null;
    try {
      primeSession = await input.primeEvaluation.start({
        purpose: "frozen-benchmark",
        adapter: context.adapter,
        baseProfile: context.baseProfile,
        signal,
      });
      if (!primeSession.models.candidate) {
        throw new Error(
          "Prime frozen evaluation did not load the candidate adapter.",
        );
      }
      let trajectories:
        MarketingBenchmarkTrajectoryReceipt[] = [];
      for (const arm of [
        "base",
        "candidate",
      ] as const) {
        const model =
          arm === "base"
            ? primeSession.models.base
            : primeSession.models.candidate;
        for (const schedule of context.specification
          .attemptSchedule) {
          throwIfAborted(signal);
          trajectories.push(
            await runTrajectory({
              arm,
              model,
              provider: "prime",
              providerResourceIds: [
                primeSession.resource.nodeId,
              ],
              providerGpuType:
                primeSession.resource.gpuType,
              schedule,
              context,
              signal,
            }),
          );
          run = await saveProgress(
            run,
            trajectories.length,
          );
        }
      }
      const released = await primeSession.release();
      primeSession = null;
      trajectories = allocatePrimeEvaluationCost(
        trajectories,
        released.costUsd,
      );
      const frontier = context.specification.arms.find(
        (arm) => arm.arm === "frontier_reference",
      )!;
      for (const schedule of context.specification
        .attemptSchedule) {
        throwIfAborted(signal);
        trajectories.push(
          await runTrajectory({
            arm: "frontier_reference",
            model: frontier.model,
            provider: frontier.model.providerId,
            providerResourceIds: [],
            providerGpuType: null,
            schedule,
            context,
            signal,
          }),
        );
        run = await saveProgress(run, trajectories.length);
      }
      const completedAt = timestamp();
      const receipt = buildMarketingBenchmarkReceipt({
        id: `marketing_benchmark_receipt_${contentHash([
          run.id,
          trajectories,
        ]).slice(0, 24)}`,
        specification: context.specification,
        candidate: context.candidate,
        trajectories,
        createdAt: completedAt,
      });
      const artifact = await persistReceipt({
        run,
        context,
        receipt,
        createdAt: completedAt,
      });
      await input.store.saveModelArtifactLineage(
        promotedLineage({
          lineage: context.lineage,
          frozenEvaluationArtifactId: artifact.id,
          promotionPassed:
            receipt.pairedComparison
              .candidatePromotionPassed,
          completedAt,
          disclosure: receipt.disclosure,
        }),
      );
      await input.store.saveMarketingBenchmarkRun({
        ...run,
        status: "succeeded",
        progress: {
          completedTrajectories: 96,
          totalTrajectories: 96,
        },
        receipt,
        error: null,
        completedAt,
        updatedAt: completedAt,
      });
    } catch (error) {
      await primeSession?.release().catch(() => undefined);
      const current = await requireRun(initialRun.id);
      if (current.status === "cancelled") return;
      const completedAt = timestamp();
      await input.store.saveMarketingBenchmarkRun({
        ...current,
        status: signal.aborted ? "cancelled" : "failed",
        error: safeMessage(
          signal.aborted ? signal.reason : error,
        ),
        completedAt,
        updatedAt: completedAt,
      });
      throw error;
    }
  }

  async function runTrajectory(runInput: {
    arm: MarketingBenchmarkArm;
    model: Parameters<BaselineAttemptRunner>[0]["model"];
    provider: string;
    providerResourceIds: string[];
    providerGpuType: string | null;
    schedule:
      MarketingBenchmarkSpecification["attemptSchedule"][number];
    context: Awaited<ReturnType<typeof resolveContext>>;
    signal: AbortSignal;
  }): Promise<MarketingBenchmarkTrajectoryReceipt> {
    const task = runInput.context.tasks.get(
      runInput.schedule.taskId,
    );
    if (!task) {
      throw new Error(
        `Frozen task ${runInput.schedule.taskId} disappeared.`,
      );
    }
    let attempt;
    try {
      attempt = await input.runAttempt({
        tasksetId:
          runInput.context.specification.taskset.id,
        task,
        model: runInput.model,
        seed: runInput.schedule.seed,
        attempt: runInput.schedule.attempt,
        sampling:
          runInput.context.specification.sampling,
        signal: runInput.signal,
      });
    } catch (error) {
      throwIfAborted(runInput.signal);
      throw new Error(
        `Marketing benchmark ${runInput.arm} trajectory ${runInput.schedule.taskId}:${runInput.schedule.attempt} failed before a valid response: ${safeMessage(error)}`,
        { cause: error },
      );
    }
    throwIfAborted(runInput.signal);
    return successfulMarketingBenchmarkTrajectory({
      arm: runInput.arm,
      schedule: runInput.schedule,
      attempt,
      specification:
        runInput.context.specification,
      candidate: runInput.context.candidate,
      adapterContentHash:
        runInput.context.artifact.sha256,
      provider: runInput.provider,
      providerResourceIds:
        runInput.providerResourceIds,
      providerGpuType: runInput.providerGpuType,
    });
  }

  async function saveProgress(
    run: MarketingBenchmarkRun,
    completedTrajectories: number,
  ): Promise<MarketingBenchmarkRun> {
    const updatedAt = timestamp();
    return input.store.saveMarketingBenchmarkRun({
      ...run,
      progress: {
        completedTrajectories,
        totalTrajectories: 96,
      },
      updatedAt,
    });
  }

  async function resolveContext(startInput: {
    specificationId: string;
    candidateModelVersionId: string;
  }) {
    const specification = (
      await input.store.listMarketingBenchmarkSpecifications()
    ).find(
      (candidate) =>
        candidate.id === startInput.specificationId,
    );
    if (!specification) {
      throw new Error(
        `Marketing benchmark specification ${startInput.specificationId} was not found.`,
      );
    }
    const candidate = await input.store.getModelVersion(
      startInput.candidateModelVersionId,
    );
    const baseProfile = candidate
      ? resolvePrimeGrpoBaseProfile(candidate.baseModel)
      : null;
    const baseArm = specification.arms.find(
      (arm) => arm.arm === "base",
    );
    if (
      !candidate
      || !baseProfile
      || candidate.kind !== "lora_adapter"
      || candidate.version !== 1
      || candidate.status !== "available"
      || candidate.modelId
        !== specification.arms.find(
          (arm) => arm.arm === "candidate",
        )?.modelProjectId
      || baseArm?.baseRepository !== baseProfile.modelId
      || baseArm.baseRevision !== baseProfile.revision
      || !candidate.artifactLineageId
    ) {
      throw new Error(
        "Frozen marketing evaluation requires an exact supported Prime-GRPO LoRA Model v1 matching its preregistered base.",
      );
    }
    const taskset = await input.store.getTasksetRevision(
      specification.taskset.id,
      specification.taskset.revision,
      specification.taskset.contentHash,
    );
    if (!taskset) {
      throw new Error(
        "The immutable benchmark Taskset revision was not found.",
      );
    }
    const tasks = new Map(
      taskset.tasks
        .filter(
          (task) =>
            task.split === "frozen_eval"
            && specification.frozenTaskIds.includes(
              task.id,
            ),
        )
        .map((task) => [task.id, task]),
    );
    if (
      tasks.size !== 8
      || [...tasks.keys()].some(
        (taskId) =>
          !specification.frozenTaskIds.includes(taskId),
      )
    ) {
      throw new Error(
        "The benchmark frozen Task set no longer matches preregistration.",
      );
    }
    const lineage =
      await input.store.getModelArtifactLineage(
        candidate.artifactLineageId,
      );
    const artifact = lineage
      ? await input.store.getTrainingArtifact(
          lineage.artifactId,
        )
      : null;
    if (
      !lineage
      || lineage.status !== "imported"
      || !artifact
      || artifact.kind !== "adapter"
      || artifact.baseModelId
        !== baseProfile.modelId
      || artifact.baseModelRevision
        !== baseProfile.revision
    ) {
      throw new Error(
        "The candidate Model lineage has no exact canonical adapter artifact.",
      );
    }
    const weights = await readFile(artifact.path);
    if (sha256(weights) !== artifact.sha256) {
      throw new Error(
        "The candidate adapter weights changed after import.",
      );
    }
    const adapterConfigPath = stringValue(
      artifact.metadata.adapterConfigPath,
    );
    const expectedConfigSha = stringValue(
      artifact.metadata.adapterConfigSha256,
    );
    if (!adapterConfigPath || !expectedConfigSha) {
      throw new Error(
        "The candidate adapter is missing its canonical config identity.",
      );
    }
    const config = await readFile(adapterConfigPath);
    if (sha256(config) !== expectedConfigSha) {
      throw new Error(
        "The candidate adapter config changed after import.",
      );
    }
    if (path.dirname(artifact.path)
      !== path.dirname(adapterConfigPath)) {
      throw new Error(
        "The canonical adapter weights and config are not co-located.",
      );
    }
    return {
      specification,
      candidate,
      taskset,
      tasks,
      lineage,
      artifact,
      baseProfile,
      adapter: {
        directory: path.dirname(artifact.path),
        configSha256: expectedConfigSha,
        weightsSha256: artifact.sha256,
      },
    };
  }

  async function persistReceipt(inputValue: {
    run: MarketingBenchmarkRun;
    context: Awaited<ReturnType<typeof resolveContext>>;
    receipt: NonNullable<MarketingBenchmarkRun["receipt"]>;
    createdAt: string;
  }) {
    const directory = path.join(
      input.storeDir,
      "training",
      "marketing-benchmark",
      inputValue.run.id,
    );
    await mkdir(directory, {
      recursive: true,
      mode: 0o700,
    });
    const receiptPath = path.join(
      directory,
      "marketing-benchmark-receipt.json",
    );
    const bytes = Buffer.from(
      canonicalJson(inputValue.receipt),
      "utf8",
    );
    await writeFile(receiptPath, bytes, { mode: 0o600 });
    const file = await stat(receiptPath);
    return input.store.saveTrainingArtifact(
      TrainingArtifactSchema.parse({
        schemaVersion: "openpond.trainingArtifact.v1",
        id: `training_artifact_${contentHash([
          inputValue.run.id,
          sha256(bytes),
        ]).slice(0, 24)}`,
        jobId: inputValue.context.lineage.jobId,
        kind: "evaluation",
        path: receiptPath,
        sha256: sha256(bytes),
        sizeBytes: file.size,
        baseModelId:
          inputValue.context.candidate.baseModel.modelId,
        baseModelRevision:
          inputValue.context.candidate.baseModel.revision,
        tokenizerRevision:
          inputValue.context.candidate.baseModel.revision,
        chatTemplateHash:
          inputValue.context.artifact.chatTemplateHash,
        nonProduction: false,
        createdAt: inputValue.createdAt,
        metadata: {
          benchmarkRunId: inputValue.run.id,
          benchmarkSpecificationId:
            inputValue.context.specification.id,
          benchmarkSpecificationHash:
            inputValue.context.specification.contentHash,
          benchmarkReceiptHash:
            inputValue.receipt.contentHash,
          candidateModelVersionId:
            inputValue.context.candidate.id,
          ...marketingBenchmarkEvaluationOutcomeMetadata(
            inputValue.receipt.pairedComparison
              .candidatePromotionPassed,
          ),
        },
      }),
    );
  }

  async function requireRun(
    runId: string,
  ): Promise<MarketingBenchmarkRun> {
    const run = (
      await input.store.listMarketingBenchmarkRuns()
    ).find((candidate) => candidate.id === runId);
    if (!run) {
      throw new Error(
        `Marketing benchmark run ${runId} was not found.`,
      );
    }
    return run;
  }

  function timestamp(): string {
    return now().toISOString();
  }

  return {
    start,
    cancel,
    reconcile,
    close,
  };
}

export function marketingBenchmarkEvaluationOutcomeMetadata(
  promotionPassed: boolean,
) {
  return {
    promotionPassed,
    evaluationComplete: true,
    thresholdPassed: promotionPassed,
  };
}

function promotedLineage(input: {
  lineage: ModelArtifactLineage;
  frozenEvaluationArtifactId: string;
  promotionPassed: boolean;
  completedAt: string;
  disclosure: string;
}): ModelArtifactLineage {
  return {
    ...input.lineage,
    frozenEvaluationArtifactId:
      input.frozenEvaluationArtifactId,
    promotable: input.promotionPassed,
    status: input.promotionPassed
      ? "imported"
      : "rejected",
    rejectedAt: input.promotionPassed
      ? null
      : input.completedAt,
    rejectionReason: input.promotionPassed
      ? null
      : input.disclosure.slice(0, 5_000),
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Marketing benchmark cancelled.");
}

function safeMessage(error: unknown): string {
  return (
    error instanceof Error ? error.message : String(error)
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}
