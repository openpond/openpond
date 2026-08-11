import {
  TurnSchema,
  type ChatModelRef,
  type ModelRun,
  type Taskset,
} from "@openpond/contracts";
import {
  contentHash,
  type HarnessRefinerMessage,
} from "@openpond/harness";

import { ensureLocalHarnessRunOverlay } from "../harness/local-harness-run-overlay.js";
import { recordLocalHarnessImprovementBoundary } from "../harness/local-harness-improvement-observer.js";
import { runLocalHarnessRefinerWorker } from "../harness/local-harness-refiner-worker.js";
import { loadLocalHarnessRuntimeFromRelease } from "../harness/local-harness-skill-runtime.js";
import type { SqliteStore } from "../store/store.js";
import { event } from "../utils.js";
import {
  BenchmarkEvidenceSnapshot,
  BenchmarkSpendBudget,
} from "./harness-refiner-benchmark-protocol.js";
import type { HostedTokenPricing } from "./hosted-token-pricing.js";
import {
  addUsage,
  attemptUsageSummary,
  benchmarkLineage,
  checkpointRefinerUsage,
  emptyUsageCategory,
  stringMetadata,
  taskPrompt,
  type BenchmarkAttemptEvidence,
} from "./harness-refiner-benchmark-service-support.js";
import {
  buildHarnessRefinerBenchmarkCohortEvidence,
} from "./harness-refiner-benchmark-cohort-evidence.js";

type BenchmarkRefinerModelStream = (input: {
  model: ChatModelRef;
  messages: HarnessRefinerMessage[];
  signal: AbortSignal;
  pricing: HostedTokenPricing;
}) => AsyncIterable<{ text?: string; usage?: unknown; costUsd?: number }>;

export async function runHarnessRefinerBenchmarkRefinerStage(input: {
  store: SqliteStore;
  storeDir: string;
  modelRun: ModelRun;
  model: ChatModelRef;
  taskset: Taskset;
  baselineRuntime: Awaited<ReturnType<typeof loadLocalHarnessRuntimeFromRelease>>;
  adaptationAttempts: BenchmarkAttemptEvidence[];
  evidenceSnapshot: BenchmarkEvidenceSnapshot;
  budget: BenchmarkSpendBudget;
  admittedPricing: HostedTokenPricing;
  refinerStream: BenchmarkRefinerModelStream;
  signal: AbortSignal;
  now: () => string;
}) {
  const refinerBoundaries: Array<{
    session: NonNullable<Awaited<ReturnType<SqliteStore["getSession"]>>>;
    turn: import("@openpond/contracts").Turn;
    result: BenchmarkAttemptEvidence;
  }> = [];
  const refinerUsage = emptyUsageCategory();
  for (const result of input.adaptationAttempts) {
    const attempt = result.attempt;
    const sessionId = stringMetadata(attempt.metadata, "sessionId");
    const turnId = stringMetadata(attempt.metadata, "turnId");
    if (!sessionId || !turnId) continue;
    const session = await input.store.getSession(sessionId);
    if (!session) continue;
    const overlay = await ensureLocalHarnessRunOverlay({
      store: input.store,
      runId: session.id,
      workspace: input.baselineRuntime.workspace,
      harnessRelease: {
        id: input.baselineRuntime.release.harnessRelease.id,
        contentHash: input.baselineRuntime.release.harnessRelease.contentHash,
      },
      admittedAt: attempt.startedAt,
    });
    const task = input.taskset.tasks.find((candidate) => candidate.id === attempt.taskId);
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
        modelRunId: input.modelRun.id,
        attemptId: attempt.id,
      },
      harnessSnapshot: {
        schemaVersion: "openpond.harnessTurnSnapshot.v1",
        workspaceId: input.baselineRuntime.workspace.id,
        workspaceRevision: input.baselineRuntime.workspace.revision,
        sourceRevision: input.baselineRuntime.workspace.sourceRevision,
        channelName: input.baselineRuntime.workspace.currentChannel.name,
        channelRevision: input.baselineRuntime.workspace.currentChannel.revision,
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
    await input.store.appendRuntimeEvent(event({
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
    refinerBoundaries.push({ session, turn, result });
  }
  const cohortEvidence = await buildHarnessRefinerBenchmarkCohortEvidence({
    taskset: input.taskset,
    adaptationAttempts: input.adaptationAttempts,
  });
  const primaryBoundary = refinerBoundaries.find(
    (boundary) =>
      boundary.result.attempt.id === cohortEvidence.primaryEvidenceAnchor.attemptId,
  );
  if (!primaryBoundary) throw new Error("Adaptation cohort produced no Refiner evidence.");
  const detection = await recordLocalHarnessImprovementBoundary({
    store: input.store,
    session: primaryBoundary.session,
    turn: primaryBoundary.turn,
    boundaryKind: "turn_completed",
    now: input.now,
  });
  if (!detection || detection.trigger.decision !== "queue_refiner") {
    throw new Error("Adaptation cohort did not produce one Refiner trigger.");
  }
  const refinerResults = [];
  input.budget.assertAvailable(`Refiner cohort ${detection.trigger.id}`);
  let refinerProviderInvoked = false;
  let refinerResult: Awaited<ReturnType<typeof runLocalHarnessRefinerWorker>>;
  try {
    refinerResult = await runLocalHarnessRefinerWorker({
      store: input.store,
      storeDir: input.storeDir,
      trigger: detection.trigger,
      additionalEvidence: cohortEvidence,
      stream: async function* (streamInput) {
        refinerProviderInvoked = true;
        for await (const delta of input.refinerStream({
          ...streamInput,
          model: input.model,
          pricing: input.admittedPricing,
        })) {
          if (delta.usage !== undefined) {
            addUsage(refinerUsage, delta.usage, delta.costUsd);
          }
          if (delta.text) yield { text: delta.text };
        }
      },
      signal: input.signal,
      now: input.now,
    });
  } finally {
    if (refinerProviderInvoked) {
      input.budget.charge(refinerUsage.costUsd, "Refiner");
      await checkpointRefinerUsage(
        input.store,
        input.modelRun.id,
        refinerUsage,
        input.budget.observedSpendUsd,
      );
    }
  }
  refinerResults.push(refinerResult);
  const candidateWorkspace = await input.store.getHarnessWorkspace(input.baselineRuntime.workspace.id);
  if (!candidateWorkspace?.currentChannel.release) {
    throw new Error("Isolated Harness candidate is unavailable.");
  }
  const candidateRecord = await input.store.getHarnessReleaseRecord(
    candidateWorkspace.currentChannel.release.contentHash,
  );
  if (!candidateRecord) throw new Error("Isolated Harness candidate release is unavailable.");
  const candidateRuntime = await loadLocalHarnessRuntimeFromRelease({
    workspace: candidateWorkspace,
    release: candidateRecord,
  });
  await input.store.setHarnessBackgroundReviewSettings({
    workspaceId: input.baselineRuntime.workspace.id,
    enabled: false,
    updatedAt: input.now(),
  });
  const outcomes = await input.store.listHarnessImprovementArtifacts(
    input.baselineRuntime.workspace.id,
    "refiner_outcome",
    1_000,
  );
  const refinerStage = {
    id: `benchmark-refiner-${input.modelRun.id}`,
    contentHash: contentHash(outcomes),
    outcomeCount: outcomes.length,
  };
  const lineage = await benchmarkLineage({
    store: input.store,
    workspaceId: input.baselineRuntime.workspace.id,
    adaptationAttempts: input.adaptationAttempts,
    refinerResults,
    candidateRelease: candidateRecord.harnessRelease,
    refinerInputHash: contentHash(cohortEvidence),
  });
  const frozenEvidence = input.evidenceSnapshot.manifest();
  return {
    candidateRecord,
    candidateRuntime,
    refinerStage,
    lineage,
    frozenEvidence,
  };
}
