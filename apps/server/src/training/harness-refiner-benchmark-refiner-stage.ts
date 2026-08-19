import {
  TurnSchema,
  type ChatModelRef,
  type ModelRun,
  type RefinementTriggerDecision,
  type Taskset,
} from "@openpond/contracts";
import {
  DEFAULT_REFINER_MAX_OUTPUT_TOKENS,
  type HarnessRefinerMessage,
} from "@openpond/harness";
import type { ArtifactManifest, RewardReceipt } from "@openpond/evals";

import { ensureLocalHarnessRunOverlay } from "../harness/local-harness-run-overlay.js";
import { recordLocalHarnessImprovementBoundary } from "../harness/local-harness-improvement-observer.js";
import { runLocalHarnessRefinerWorker } from "../harness/local-harness-refiner-worker.js";
import { loadLocalHarnessRuntimeFromRelease } from "../harness/local-harness-skill-runtime.js";
import type { SqliteStore } from "../store/store.js";
import { event } from "../utils.js";
import { BenchmarkSpendBudget } from "./harness-refiner-benchmark-protocol.js";
import type { BenchmarkRefinerFailureKind } from "./harness-refiner-benchmark-sequential-checkpoint.js";
import type { HostedTokenPricing } from "./hosted-token-pricing.js";
import {
  addUsage,
  attemptUsageSummary,
  checkpointRefinerUsage,
  emptyUsageCategory,
  stringMetadata,
  taskPrompt,
  type BenchmarkAttemptEvidence,
} from "./harness-refiner-benchmark-service-support.js";

type BenchmarkRefinerModelStream = (input: {
  model: ChatModelRef;
  messages: HarnessRefinerMessage[];
  signal: AbortSignal;
  pricing: HostedTokenPricing;
}) => AsyncIterable<{ text?: string; usage?: unknown; costUsd?: number }>;

const MAX_REFINER_ARTIFACT_MANIFEST_ENTRIES = 100;

type RefinerUsage = ReturnType<typeof emptyUsageCategory>;

export class BenchmarkRefinerInvocationError extends Error {
  readonly name = "BenchmarkRefinerInvocationError";

  constructor(
    message: string,
    readonly details: {
      trigger: RefinementTriggerDecision;
      usage: RefinerUsage;
      costBasis: "authoritative" | "estimated" | "none";
      estimatedCostUsd: number | null;
      failureKind: BenchmarkRefinerFailureKind;
      retryable: boolean;
      startedAt: string;
      completedAt: string;
    },
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function benchmarkRefinerRewardPacket(input: {
  attempt: BenchmarkAttemptEvidence["attempt"];
  artifactManifest: ArtifactManifest;
  rewardReceipt: RewardReceipt;
  artifactCount: number;
}): Record<string, unknown> {
  const manifestEntries = input.artifactManifest.entries.slice(
    0,
    MAX_REFINER_ARTIFACT_MANIFEST_ENTRIES,
  );
  return {
    schemaVersion: "openpond.refinerRewardPacket.v1",
    attemptRef: input.rewardReceipt.attemptRef,
    artifactManifest: {
      ref: {
        id: input.artifactManifest.id,
        contentHash: input.artifactManifest.contentHash,
      },
      entries: manifestEntries,
      entryCount: input.artifactManifest.entries.length,
      truncated: manifestEntries.length < input.artifactManifest.entries.length,
    },
    rewardReceipt: input.rewardReceipt,
    attempt: {
      status: input.rewardReceipt.outcomeClass,
      infrastructureError: input.attempt.infrastructureError,
      outputPresent:
        typeof input.attempt.output.text === "string"
        && input.attempt.output.text.trim().length > 0,
      artifactCount: input.artifactCount,
      runtimeEventCount: input.attempt.runtimeEventRefs.length,
      modelRequestCount: Array.isArray(input.attempt.metadata.usage)
        ? input.attempt.metadata.usage.length
        : input.attempt.metadata.usage
          ? 1
          : 0,
      latencyMs: input.attempt.latencyMs,
      usage: attemptUsageSummary(input.attempt.metadata.usage),
    },
  };
}

export async function materializeBenchmarkRefinerBoundary(input: {
  store: SqliteStore;
  modelRun: ModelRun;
  model: ChatModelRef;
  taskset: Taskset;
  runtime: Awaited<ReturnType<typeof loadLocalHarnessRuntimeFromRelease>>;
  result: BenchmarkAttemptEvidence;
}) {
  const attempt = input.result.attempt;
  const sessionId = stringMetadata(attempt.metadata, "sessionId");
  const turnId = stringMetadata(attempt.metadata, "turnId");
  if (!sessionId || !turnId) return null;
  const session = await input.store.getSession(sessionId);
  if (!session) return null;
  const overlay = await ensureLocalHarnessRunOverlay({
    store: input.store,
    runId: session.id,
    workspace: input.runtime.workspace,
    harnessRelease: {
      id: input.runtime.release.harnessRelease.id,
      contentHash: input.runtime.release.harnessRelease.contentHash,
    },
    admittedAt: attempt.startedAt,
  });
  const task = input.taskset.tasks.find((candidate) => candidate.id === attempt.taskId);
  if (!task) return null;
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
      modelRunId: input.modelRun.id,
      attemptId: attempt.id,
    },
    harnessSnapshot: {
      schemaVersion: "openpond.harnessTurnSnapshot.v1",
      workspaceId: input.runtime.workspace.id,
      workspaceRevision: input.runtime.workspace.revision,
      sourceRevision: input.runtime.workspace.sourceRevision,
      channelName: input.runtime.workspace.currentChannel.name,
      channelRevision: input.runtime.workspace.currentChannel.revision,
      harnessRelease: overlay.baseHarnessRelease,
      overlay: {
        id: overlay.id,
        revision: overlay.revision,
        contentHash: overlay.contentHash,
      },
    },
  });
  if (!(await input.store.getTurn(turn.id))) await input.store.insertTurn(turn);
  const assistantOutput = attempt.output.text;
  if (typeof assistantOutput === "string" && assistantOutput.trim()) {
    await input.store.appendRuntimeEvent(event({
      sessionId: session.id,
      turnId: turn.id,
      name: "assistant.delta",
      source: "server",
      appId: session.appId,
      status: "completed",
      output: assistantOutput,
    }));
  }
  const rewardPacket = benchmarkRefinerRewardPacket({
    attempt,
    artifactManifest: input.result.artifactManifest,
    rewardReceipt: input.result.rewardReceipt,
    artifactCount: input.result.artifacts.length,
  });
  const rewardEvidence = JSON.stringify(rewardPacket);
  const rewardPassed = input.result.rewardReceipt.status === "scored"
    && input.result.rewardReceipt.passed;
  await input.store.appendRuntimeEvent(event({
    sessionId: session.id,
    turnId: turn.id,
    name: "diagnostic",
    source: "server",
    appId: session.appId,
    action: "taskset_grade",
    status: rewardPassed ? "completed" : "failed",
    output: rewardEvidence,
    error: rewardPassed ? undefined : rewardEvidence,
    data: {
      result: {
        output: rewardEvidence,
        passed: rewardPassed,
        status: input.result.rewardReceipt.status,
        reward: input.result.rewardReceipt.reward,
        rewardReceiptRef: {
          id: input.result.rewardReceipt.id,
          contentHash: input.result.rewardReceipt.contentHash,
        },
        artifactManifestRef: {
          id: input.result.artifactManifest.id,
          contentHash: input.result.artifactManifest.contentHash,
        },
      },
    },
  }));
  return { session, turn, result: input.result };
}

export async function runBenchmarkRefinerAfterAttempt(input: {
  store: SqliteStore;
  storeDir: string;
  modelRun: ModelRun;
  model: ChatModelRef;
  taskset: Taskset;
  runtime: Awaited<ReturnType<typeof loadLocalHarnessRuntimeFromRelease>>;
  result: BenchmarkAttemptEvidence;
  budget: BenchmarkSpendBudget;
  admittedPricing: HostedTokenPricing;
  refinerStream: BenchmarkRefinerModelStream;
  signal: AbortSignal;
  now: () => string;
}) {
  const boundary = await materializeBenchmarkRefinerBoundary(input);
  if (!boundary) {
    throw new Error(`Adaptation attempt ${input.result.attempt.id} has no Refiner boundary.`);
  }
  const existingTrigger = await queuedTriggerForTurn({
    store: input.store,
    workspaceId: input.runtime.workspace.id,
    turnId: boundary.turn.id,
  });
  const detection = existingTrigger
    ? { observations: [], trigger: existingTrigger }
    : await recordLocalHarnessImprovementBoundary({
        store: input.store,
        session: boundary.session,
        turn: boundary.turn,
        boundaryKind: "turn_completed",
        now: input.now,
      });
  if (!detection) {
    throw new Error(`Adaptation attempt ${input.result.attempt.id} produced no Refiner detection.`);
  }
  if (detection.trigger.decision !== "queue_refiner") {
    return { detection, result: null };
  }
  input.budget.assertAvailable(`Refiner turn ${detection.trigger.id}`);
  const usage = emptyUsageCategory();
  let providerInvoked = false;
  let providerRequestCount = 0;
  let requestsWithAuthoritativeCost = 0;
  let estimatedCostUsd = 0;
  const startedAt = input.now();
  let result: Awaited<ReturnType<typeof runLocalHarnessRefinerWorker>> | null = null;
  let failure: unknown = null;
  try {
    result = await runLocalHarnessRefinerWorker({
      store: input.store,
      storeDir: input.storeDir,
      trigger: detection.trigger,
      stream: async function* (streamInput) {
        providerInvoked = true;
        providerRequestCount += 1;
        let requestHadAuthoritativeCost = false;
        estimatedCostUsd += conservativeRefinerRequestCost(
          streamInput.messages,
          input.admittedPricing,
        );
        try {
          for await (const delta of input.refinerStream({
            ...streamInput,
            model: input.model,
            pricing: input.admittedPricing,
          })) {
            if (typeof delta.costUsd === "number") requestHadAuthoritativeCost = true;
            if (delta.usage !== undefined || delta.costUsd !== undefined) {
              addUsage(usage, delta.usage, delta.costUsd);
            }
            if (delta.text) yield { text: delta.text };
          }
        } finally {
          if (requestHadAuthoritativeCost) requestsWithAuthoritativeCost += 1;
        }
      },
      signal: input.signal,
      now: input.now,
    });
  } catch (error) {
    failure = error;
  }
  const completedAt = input.now();
  const costBasis = providerInvoked
    ? usage.costUsd !== null && requestsWithAuthoritativeCost === providerRequestCount
      ? "authoritative" as const
      : "estimated" as const
    : "none" as const;
  const chargedCost = costBasis === "authoritative"
    ? usage.costUsd
    : costBasis === "estimated"
      ? Math.max(usage.costUsd ?? 0, estimatedCostUsd)
      : null;
  if (providerInvoked) {
    try {
      input.budget.charge(chargedCost, "Refiner");
      await checkpointRefinerUsage(
        input.store,
        input.modelRun.id,
        usage,
        input.budget.observedSpendUsd,
      );
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    const failureKind = benchmarkRefinerFailureKind(failure, input.signal);
    const retryable = failureKind !== "cancelled";
    await input.store.appendRuntimeEvent(event({
      sessionId: boundary.session.id,
      turnId: boundary.turn.id,
      name: "harness.refiner.failed",
      source: "server",
      appId: boundary.session.appId,
      status: "failed",
      output: message,
      data: {
        trigger: {
          id: detection.trigger.id,
          contentHash: detection.trigger.contentHash,
        },
        benchmark: true,
        modelRunId: input.modelRun.id,
        attemptId: input.result.attempt.id,
        failureKind,
        retryable,
        costBasis,
        estimatedCostUsd: costBasis === "estimated" ? estimatedCostUsd : null,
      },
    })).catch(() => undefined);
    throw new BenchmarkRefinerInvocationError(message, {
      trigger: detection.trigger,
      usage,
      costBasis,
      estimatedCostUsd: costBasis === "estimated" ? estimatedCostUsd : null,
      failureKind,
      retryable,
      startedAt,
      completedAt,
    }, { cause: failure });
  }
  return {
    detection,
    result,
    invocation: {
      usage,
      costBasis,
      estimatedCostUsd: costBasis === "estimated" ? estimatedCostUsd : null,
      startedAt,
      completedAt,
    },
  };
}

async function queuedTriggerForTurn(input: {
  store: SqliteStore;
  workspaceId: string;
  turnId: string;
}): Promise<RefinementTriggerDecision | null> {
  const triggers = await input.store.listHarnessImprovementArtifacts(
    input.workspaceId,
    "trigger_decision",
    1_000,
  ) as RefinementTriggerDecision[];
  return triggers.find(
    (trigger) => trigger.turnId === input.turnId && trigger.decision === "queue_refiner",
  ) ?? null;
}

function conservativeRefinerRequestCost(
  messages: HarnessRefinerMessage[],
  pricing: HostedTokenPricing,
): number {
  const inputCharacters = messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  const estimatedInputTokens = Math.ceil(inputCharacters / 3);
  return (
    estimatedInputTokens * pricing.inputUsdPerMillionTokens
    + DEFAULT_REFINER_MAX_OUTPUT_TOKENS * pricing.outputUsdPerMillionTokens
  ) / 1_000_000;
}

function benchmarkRefinerFailureKind(
  error: unknown,
  signal: AbortSignal,
): BenchmarkRefinerFailureKind {
  if (signal.aborted) return "cancelled";
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (/invalid structured output|response limit|JSON/i.test(message)) {
    return "invalid_output";
  }
  if (/provider|rate limit|billing|signed out|network|fetch/i.test(message)) {
    return "provider_failure";
  }
  return "unknown";
}
