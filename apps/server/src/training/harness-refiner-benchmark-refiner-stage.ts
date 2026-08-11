import {
  TurnSchema,
  type ChatModelRef,
  type ModelRun,
  type Taskset,
} from "@openpond/contracts";
import type { HarnessRefinerMessage } from "@openpond/harness";

import { ensureLocalHarnessRunOverlay } from "../harness/local-harness-run-overlay.js";
import { recordLocalHarnessImprovementBoundary } from "../harness/local-harness-improvement-observer.js";
import { runLocalHarnessRefinerWorker } from "../harness/local-harness-refiner-worker.js";
import { loadLocalHarnessRuntimeFromRelease } from "../harness/local-harness-skill-runtime.js";
import type { SqliteStore } from "../store/store.js";
import { event } from "../utils.js";
import { BenchmarkSpendBudget } from "./harness-refiner-benchmark-protocol.js";
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
  const gradeEvidence = JSON.stringify({
    schemaVersion: input.result.grade.schemaVersion,
    id: input.result.grade.id,
    passed: input.result.grade.passed,
    score: input.result.grade.score,
    failureClass: input.result.grade.failureClass,
    rewardEligible: input.result.grade.rewardEligible,
    feedback: input.result.grade.feedback,
    evaluationCriteria: task.expectedOutput,
    attempt: {
      status: attempt.infrastructureError ? "infrastructure_failure" : "completed",
      infrastructureError: attempt.infrastructureError,
      outputPresent:
        typeof attempt.output.text === "string" && attempt.output.text.trim().length > 0,
      artifactCount: input.result.artifacts.length,
      runtimeEventCount: attempt.runtimeEventRefs.length,
      modelRequestCount: Array.isArray(attempt.metadata.usage)
        ? attempt.metadata.usage.length
        : attempt.metadata.usage
          ? 1
          : 0,
      latencyMs: attempt.latencyMs,
      usage: attemptUsageSummary(attempt.metadata.usage),
    },
  });
  await input.store.appendRuntimeEvent(event({
    sessionId: session.id,
    turnId: turn.id,
    name: "diagnostic",
    source: "server",
    appId: session.appId,
    action: "taskset_grade",
    status: input.result.grade.passed ? "completed" : "failed",
    output: gradeEvidence,
    error: input.result.grade.passed ? undefined : gradeEvidence,
    data: {
      result: {
        output: gradeEvidence,
        passed: input.result.grade.passed,
        score: input.result.grade.score,
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
  const detection = await recordLocalHarnessImprovementBoundary({
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
  try {
    const result = await runLocalHarnessRefinerWorker({
      store: input.store,
      storeDir: input.storeDir,
      trigger: detection.trigger,
      stream: async function* (streamInput) {
        providerInvoked = true;
        for await (const delta of input.refinerStream({
          ...streamInput,
          model: input.model,
          pricing: input.admittedPricing,
        })) {
          if (delta.usage !== undefined) addUsage(usage, delta.usage, delta.costUsd);
          if (delta.text) yield { text: delta.text };
        }
      },
      signal: input.signal,
      now: input.now,
    });
    return { detection, result };
  } finally {
    if (providerInvoked) {
      input.budget.charge(usage.costUsd, "Refiner");
      await checkpointRefinerUsage(
        input.store,
        input.modelRun.id,
        usage,
        input.budget.observedSpendUsd,
      );
    }
  }
}
