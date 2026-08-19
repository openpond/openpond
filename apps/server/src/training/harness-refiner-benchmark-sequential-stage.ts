import type { ChatModelRef, ModelRun, Taskset } from "@openpond/contracts";
import { contentHash, type HarnessRefinerMessage } from "@openpond/harness";

import { loadLocalHarnessRuntimeFromRelease } from "../harness/local-harness-skill-runtime.js";
import type { SqliteStore } from "../store/store.js";
import {
  BenchmarkSpendBudget,
  HARNESS_REFINER_BENCHMARK_MAX_INVOCATIONS_PER_TASK,
  type BenchmarkEvidenceSnapshot,
  type SequentialAdaptationStep,
  type SequentialAdaptationSummary,
} from "./harness-refiner-benchmark-protocol.js";
import {
  frozenToolEvidence,
  loadBenchmarkAttemptEvidenceByIds,
  releasedHarness,
  type BenchmarkAttemptEvidence,
  type EvaluationAttempt,
} from "./harness-refiner-benchmark-service-support.js";
import { benchmarkLineage } from "./harness-refiner-benchmark-lineage.js";
import {
  BenchmarkRefinerInvocationError,
  runBenchmarkRefinerAfterAttempt,
} from "./harness-refiner-benchmark-refiner-stage.js";
import {
  appendSequentialAdaptationInvocation,
  createBenchmarkRefinerInvocationReceipt,
  initializeSequentialAdaptationCheckpoint,
} from "./harness-refiner-benchmark-sequential-checkpoint.js";
import type { HostedTokenPricing } from "./hosted-token-pricing.js";
import type { createTaskEvaluationService } from "./evaluation-service.js";

type Evaluation = ReturnType<typeof createTaskEvaluationService>;

type BenchmarkRefinerModelStream = (input: {
  model: ChatModelRef;
  messages: HarnessRefinerMessage[];
  signal: AbortSignal;
  pricing: HostedTokenPricing;
}) => AsyncIterable<{ text?: string; usage?: unknown; costUsd?: number }>;

export async function runSequentialHarnessAdaptation(input: {
  store: SqliteStore;
  storeDir: string;
  evaluation: Evaluation;
  modelRun: ModelRun;
  model: ChatModelRef;
  reasoningEffort: import("@openpond/contracts").CodexReasoningEffort | "none" | null;
  taskset: Taskset;
  taskIds: string[];
  seed: number;
  initialRuntime: Awaited<ReturnType<typeof loadLocalHarnessRuntimeFromRelease>>;
  evidenceSnapshot: BenchmarkEvidenceSnapshot;
  budget: BenchmarkSpendBudget;
  admittedPricing: HostedTokenPricing;
  refinerStream: BenchmarkRefinerModelStream;
  signal: AbortSignal;
  now: () => string;
  onAttemptComplete: (result: EvaluationAttempt) => Promise<void>;
  adapters?: {
    runRefinerAfterAttempt?: typeof runBenchmarkRefinerAfterAttempt;
    loadRuntimeFromRelease?: typeof loadLocalHarnessRuntimeFromRelease;
    buildLineage?: typeof benchmarkLineage;
    loadAttemptEvidenceByIds?: typeof loadBenchmarkAttemptEvidenceByIds;
  };
}) {
  const runRefinerAfterAttempt = input.adapters?.runRefinerAfterAttempt
    ?? runBenchmarkRefinerAfterAttempt;
  const loadRuntimeFromRelease = input.adapters?.loadRuntimeFromRelease
    ?? loadLocalHarnessRuntimeFromRelease;
  const buildLineage = input.adapters?.buildLineage ?? benchmarkLineage;
  const loadAttemptEvidenceByIds = input.adapters?.loadAttemptEvidenceByIds
    ?? loadBenchmarkAttemptEvidenceByIds;
  await input.store.setHarnessBackgroundReviewSettings({
    workspaceId: input.initialRuntime.workspace.id,
    enabled: true,
    updatedAt: input.now(),
  });
  const initialHarness = {
    id: input.initialRuntime.release.harnessRelease.id,
    contentHash: input.initialRuntime.release.harnessRelease.contentHash,
  };
  let checkpoint = await initializeSequentialAdaptationCheckpoint({
    storeDir: input.storeDir,
    modelRunId: input.modelRun.id,
    initialHarness,
    now: input.now(),
  });
  assertCheckpointTaskOrder(checkpoint.steps, input.taskIds);
  let runtime = await restoreCheckpointRuntime({
    store: input.store,
    initialRuntime: input.initialRuntime,
    steps: checkpoint.steps,
    loadRuntimeFromRelease,
  });
  const attempts: BenchmarkAttemptEvidence[] = checkpoint.steps.length
    ? await loadAttemptEvidenceByIds({
        store: input.store,
        tasksetId: input.taskset.id,
        attemptIds: checkpoint.steps.map((step) => step.attemptId),
      })
    : [];
  const attemptsById = new Map(attempts.map((attempt) => [attempt.attempt.id, attempt]));
  const refinerResults: Array<NonNullable<Awaited<ReturnType<
    typeof runBenchmarkRefinerAfterAttempt
  >>["result"]>> = [];
  const steps: SequentialAdaptationStep[] = [...checkpoint.steps];

  try {
    for (const [ordinal, taskId] of input.taskIds.entries()) {
      if (ordinal < steps.length) continue;
      input.signal.throwIfAborted();
      const before = {
        id: runtime.release.harnessRelease.id,
        contentHash: runtime.release.harnessRelease.contentHash,
      };
      const priorInvocations = checkpoint.invocations.filter(
        (invocation) => invocation.taskId === taskId,
      );
      const lastInvocation = priorInvocations.at(-1);
      if (
        lastInvocation?.status === "failed"
        && priorInvocations.length >= HARNESS_REFINER_BENCHMARK_MAX_INVOCATIONS_PER_TASK
      ) {
        throw new Error(
          `Sequential Refiner exhausted ${HARNESS_REFINER_BENCHMARK_MAX_INVOCATIONS_PER_TASK} admitted invocations for ${taskId}.`,
        );
      }
      let evidence = lastInvocation?.status === "failed"
        ? attemptsById.get(lastInvocation.attemptId)
        : undefined;
      if (!evidence && lastInvocation?.status === "failed") {
        [evidence] = await loadAttemptEvidenceByIds({
          store: input.store,
          tasksetId: input.taskset.id,
          attemptIds: [lastInvocation.attemptId],
        });
        if (evidence) {
          attempts.push(evidence);
          attemptsById.set(evidence.attempt.id, evidence);
        }
      }
      if (!evidence) {
        const executed = await input.evaluation.execute({
          tasksetId: input.taskset.id,
          taskId,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          seed: input.seed,
          attempt: 0,
          sampling: { maxOutputTokens: 4_096, temperature: 0, topP: 1 },
          releasedHarness: releasedHarness(runtime.release, runtime.instructionContext),
          hostedTokenPricing: input.admittedPricing,
          parentModelRunId: input.modelRun.id,
          signal: input.signal,
          toolEvidence: frozenToolEvidence(input.evidenceSnapshot, "replay", "adaptation"),
        });
        await input.onAttemptComplete(executed);
        evidence = {
          attempt: executed.attempt,
          grade: executed.grade,
          artifacts: executed.artifacts,
          receiptContentHash: executed.portable.receipt.contentHash,
          artifactManifest: executed.portable.artifactManifest,
          rewardReceipt: executed.portable.rewardReceipt,
        };
        attempts.push(evidence);
        attemptsById.set(evidence.attempt.id, evidence);
      }
      let refined: Awaited<ReturnType<typeof runBenchmarkRefinerAfterAttempt>>;
      try {
        refined = await runRefinerAfterAttempt({
          store: input.store,
          storeDir: input.storeDir,
          modelRun: input.modelRun,
          model: input.model,
          taskset: input.taskset,
          runtime,
          result: evidence,
          budget: input.budget,
          admittedPricing: input.admittedPricing,
          refinerStream: input.refinerStream,
          signal: input.signal,
          now: input.now,
        });
      } catch (error) {
        if (error instanceof BenchmarkRefinerInvocationError) {
          checkpoint = await appendSequentialAdaptationInvocation({
            storeDir: input.storeDir,
            modelRunId: input.modelRun.id,
            initialHarness,
            invocation: createBenchmarkRefinerInvocationReceipt({
              taskId,
              attemptId: evidence.attempt.id,
              invocationOrdinal: priorInvocations.length,
              trigger: {
                id: error.details.trigger.id,
                contentHash: error.details.trigger.contentHash,
              },
              status: "failed",
              outcome: null,
              failure: {
                kind: error.details.failureKind,
                message: error.message.slice(0, 2_000),
                retryable: error.details.retryable,
              },
              inputHarness: before,
              outputHarness: before,
              usage: error.details.usage,
              costBasis: error.details.costBasis,
              estimatedCostUsd: error.details.estimatedCostUsd,
              startedAt: error.details.startedAt,
              completedAt: error.details.completedAt,
            }),
            now: error.details.completedAt,
          });
        }
        throw error;
      }
      if (refined.result) refinerResults.push(refined.result);

      const workspace = await input.store.getHarnessWorkspace(runtime.workspace.id);
      const releaseRef = workspace?.currentChannel.release;
      if (!workspace || !releaseRef) {
        throw new Error("Sequential Refiner did not retain a current Harness release.");
      }
      const release = await input.store.getHarnessReleaseRecord(releaseRef.contentHash);
      if (!release) throw new Error("Sequential Refiner release is unavailable.");
      runtime = await loadRuntimeFromRelease({ workspace, release });
      const after = {
        id: runtime.release.harnessRelease.id,
        contentHash: runtime.release.harnessRelease.contentHash,
      };
      const step: SequentialAdaptationStep = {
        ordinal,
        taskId,
        attemptId: evidence.attempt.id,
        inputHarness: before,
        outputHarness: after,
        trigger: {
          id: refined.detection.trigger.id,
          contentHash: refined.detection.trigger.contentHash,
          decision: refined.detection.trigger.decision,
        },
        outcome: refined.result
          ? {
              id: refined.result.outcome.id,
              contentHash: refined.result.outcome.contentHash,
              decision: refined.result.outcome.decision,
            }
          : null,
        changed: before.contentHash !== after.contentHash,
      };
      steps.push(step);
      const invocation = refined.result && refined.invocation
        ? createBenchmarkRefinerInvocationReceipt({
            taskId,
            attemptId: evidence.attempt.id,
            invocationOrdinal: priorInvocations.length,
            trigger: {
              id: refined.detection.trigger.id,
              contentHash: refined.detection.trigger.contentHash,
            },
            status: "completed",
            outcome: {
              id: refined.result.outcome.id,
              contentHash: refined.result.outcome.contentHash,
              decision: refined.result.outcome.decision,
            },
            failure: null,
            inputHarness: before,
            outputHarness: after,
            usage: refined.invocation.usage,
            costBasis: refined.invocation.costBasis,
            estimatedCostUsd: refined.invocation.estimatedCostUsd,
            startedAt: refined.invocation.startedAt,
            completedAt: refined.invocation.completedAt,
          })
        : undefined;
      checkpoint = await appendSequentialAdaptationInvocation({
        storeDir: input.storeDir,
        modelRunId: input.modelRun.id,
        initialHarness,
        invocation,
        step,
        now: input.now(),
      });
    }
  } finally {
    await input.store.setHarnessBackgroundReviewSettings({
      workspaceId: input.initialRuntime.workspace.id,
      enabled: false,
      updatedAt: input.now(),
    });
  }

  const usage = attempts.reduce(
    (total, evidence) => {
      const records = Array.isArray(evidence.attempt.metadata.usage)
        ? evidence.attempt.metadata.usage
        : [evidence.attempt.metadata.usage];
      for (const value of records) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        const inputTokens = numericToken(record, [
          "promptTokens",
          "prompt_tokens",
          "inputTokens",
          "input_tokens",
        ]);
        const outputTokens = numericToken(record, [
          "completionTokens",
          "completion_tokens",
          "outputTokens",
          "output_tokens",
        ]);
        total.inputTokens += inputTokens;
        total.outputTokens += outputTokens;
        total.totalTokens += numericToken(record, ["totalTokens", "total_tokens"])
          || inputTokens + outputTokens;
      }
      return total;
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  const costs = attempts.flatMap((evidence) =>
    typeof evidence.attempt.costUsd === "number" ? [evidence.attempt.costUsd] : []
  );
  const finalHarness = {
    id: runtime.release.harnessRelease.id,
    contentHash: runtime.release.harnessRelease.contentHash,
  };
  const summaryCore = {
    schemaVersion: "openpond.sequentialHarnessAdaptation.v1" as const,
    id: `sequential-adaptation-${input.modelRun.id}`,
    initialHarness,
    finalHarness,
    attemptCount: attempts.length,
    passedCount: attempts.filter((evidence) => evidence.grade.passed).length,
    terminalCount: attempts.filter((evidence) => !evidence.attempt.infrastructureError).length,
    usage,
    costUsd: costs.length ? costs.reduce((total, cost) => total + cost, 0) : null,
    latencyMs: attempts.reduce((total, evidence) => total + evidence.attempt.latencyMs, 0),
    steps,
    createdAt: input.now(),
  };
  const summary: SequentialAdaptationSummary = {
    ...summaryCore,
    contentHash: contentHash(summaryCore),
  };
  const outcomes = await input.store.listHarnessImprovementArtifacts(
    input.initialRuntime.workspace.id,
    "refiner_outcome",
    1_000,
  );
  const refinerStage = {
    id: `benchmark-refiner-${input.modelRun.id}`,
    contentHash: contentHash(outcomes),
    outcomeCount: outcomes.length,
  };
  const lineage = await buildLineage({
    store: input.store,
    workspaceId: input.initialRuntime.workspace.id,
    adaptationAttempts: attempts,
    completedSteps: steps,
    candidateRelease: finalHarness,
    refinerInputHash: contentHash(attempts.map((evidence) => ({
      attempt: evidence.attempt.id,
      receipt: evidence.receiptContentHash,
      grade: contentHash(evidence.grade),
    }))),
  });
  return {
    attempts,
    runtime,
    summary,
    refinerStage,
    lineage,
    refinerResults,
  };
}

function assertCheckpointTaskOrder(
  steps: SequentialAdaptationStep[],
  taskIds: string[],
): void {
  for (const [index, step] of steps.entries()) {
    if (step.ordinal !== index || step.taskId !== taskIds[index]) {
      throw new Error("Sequential adaptation checkpoint drifted from the admitted task order.");
    }
  }
}

async function restoreCheckpointRuntime(input: {
  store: SqliteStore;
  initialRuntime: Awaited<ReturnType<typeof loadLocalHarnessRuntimeFromRelease>>;
  steps: SequentialAdaptationStep[];
  loadRuntimeFromRelease: typeof loadLocalHarnessRuntimeFromRelease;
}) {
  const last = input.steps.at(-1);
  if (!last) return input.initialRuntime;
  const workspace = await input.store.getHarnessWorkspace(input.initialRuntime.workspace.id);
  if (
    !workspace?.currentChannel.release
    || workspace.currentChannel.release.id !== last.outputHarness.id
    || workspace.currentChannel.release.contentHash !== last.outputHarness.contentHash
  ) {
    throw new Error("Sequential adaptation workspace drifted from its durable checkpoint.");
  }
  const release = await input.store.getHarnessReleaseRecord(last.outputHarness.contentHash);
  if (!release || release.harnessRelease.id !== last.outputHarness.id) {
    throw new Error("Sequential adaptation checkpoint release is unavailable.");
  }
  return input.loadRuntimeFromRelease({ workspace, release });
}

function numericToken(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
  }
  return 0;
}
