import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  TaskAttemptArtifactSchema,
  TaskAttemptResultSchema,
  type ChatModelRef,
  type CodexReasoningEffort,
  type CrossSystemTrajectory,
  type CrossSystemVerifierResult,
  type TaskDataRecord,
  type Taskset,
} from "@openpond/contracts";
import { contentHash, sha256, type BaselineAttemptRunner } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import {
  resolveCrossSystemTask,
  runCrossSystemRollout,
  verifyCrossSystemTrajectory,
  type CrossSystemFrontierModelStream,
} from "./cross-system-operations/index.js";

type ModelTextRunner = (input: {
  model: ChatModelRef;
  reasoningEffort?: CodexReasoningEffort | "none" | null;
  messages: Array<{ role: "system" | "user"; content: string }>;
  signal: AbortSignal;
  requestId: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
}) => Promise<string>;

type TrainingBaselineAttemptInput = {
  tasksetId: string;
  task: TaskDataRecord;
  model: ChatModelRef;
  seed: number;
  attempt: number;
  sampling?: {
    maxOutputTokens: number;
    temperature: number;
    topP: number;
  };
  signal?: AbortSignal;
};

export function createTrainingBaselineAttemptRunner(input: {
  store: SqliteStore;
  storeDir: string;
  modelText: ModelTextRunner;
  crossSystemStream: CrossSystemFrontierModelStream;
  timestamp?: () => string;
}): BaselineAttemptRunner {
  const timestamp = input.timestamp ?? (() => new Date().toISOString());

  return (attemptInput) => runTrainingTasksetAttempt({
    ...input,
    timestamp,
    attemptInput,
  });
}

export async function runTrainingTasksetAttempt(input: {
  store: SqliteStore;
  storeDir: string;
  modelText: ModelTextRunner;
  crossSystemStream: CrossSystemFrontierModelStream;
  timestamp?: () => string;
  resultId?: string;
  attemptInput: TrainingBaselineAttemptInput;
}) {
  const timestamp = input.timestamp ?? (() => new Date().toISOString());
  const taskset = await input.store.getTaskset(input.attemptInput.tasksetId);
  if (!taskset) {
    throw new Error(`Taskset ${input.attemptInput.tasksetId} was not found.`);
  }
  return isCrossSystemTaskset(taskset)
    ? runCrossSystemAttempt({
        ...input,
        timestamp,
        taskset,
      })
    : runTextAttempt({
        ...input,
        timestamp,
      });
}

export function isCrossSystemTaskset(taskset: Taskset): boolean {
  const tasksetFlagship = taskset.metadata.flagship === "cross-system-operations";
  const environmentFlagship =
    taskset.environment.metadata.flagship === "cross-system-operations";
  return (
    (tasksetFlagship || environmentFlagship)
    && taskset.environment.stateful
    && taskset.environment.metadata.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH
  );
}

async function runCrossSystemAttempt(input: {
  store: SqliteStore;
  storeDir: string;
  crossSystemStream: CrossSystemFrontierModelStream;
  timestamp: () => string;
  resultId?: string;
  taskset: Taskset;
  attemptInput: TrainingBaselineAttemptInput;
}) {
  const { attemptInput, taskset } = input;
  const startedAt = input.timestamp();
  const requestId = baselineRequestId(attemptInput, startedAt);
  const context = resolveCrossSystemTask(taskset, {
    taskId: attemptInput.task.id,
    prompt: typeof attemptInput.task.input.prompt === "string"
      ? attemptInput.task.input.prompt
      : null,
  });
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(
    attemptInput.signal?.reason ?? new Error("The baseline was cancelled."),
  );
  attemptInput.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeoutMs = Math.max(
    1,
    Math.min(taskset.environment.defaultTimeoutMs, 10 * 60_000),
  );
  const timer = setTimeout(
    () => controller.abort(new Error(`Cross-System baseline exceeded ${timeoutMs} ms.`)),
    timeoutMs,
  );
  timer.unref?.();
  try {
    const priorInfrastructureTrajectories: CrossSystemTrajectory[] = [];
    let trajectory: CrossSystemTrajectory | null = null;
    let verifier: CrossSystemVerifierResult | null = null;
    for (let retry = 0; retry <= 1; retry += 1) {
      trajectory = await runCrossSystemRollout({
        world: context.world,
        task: context.generatedTask,
        model: attemptInput.model,
        reasoningEffort: null,
        stream: input.crossSystemStream,
        signal: controller.signal,
        trajectoryId: `cso_taskset_baseline_${contentHash([
          requestId,
          retry,
        ]).slice(0, 24)}`,
        metadata: {
          baseline: "taskset",
          execution: "taskset_baseline_tool_loop",
          tasksetId: taskset.id,
          tasksetHash: taskset.contentHash,
          samplingSeed: attemptInput.seed,
          attempt: attemptInput.attempt,
          infrastructureRetryAttempt: retry,
          priorInfrastructureErrors: priorInfrastructureTrajectories.map(
            (prior) => prior.infrastructureError ?? "Unknown infrastructure failure.",
          ),
        },
      });
      verifier = verifyCrossSystemTrajectory({
        task: context.generatedTask,
        trajectory,
      });
      if (verifier.outcome !== "infrastructure_failure" || retry === 1) break;
      priorInfrastructureTrajectories.push(trajectory);
    }
    if (!trajectory || !verifier) {
      throw new Error(`Cross-System task ${attemptInput.task.id} produced no trajectory.`);
    }
    const final = [...trajectory.steps]
      .reverse()
      .find((step) => step.kind === "final");
    const completedAt = trajectory.completedAt;
    const attemptId = input.resultId ?? `attempt_${contentHash([
      requestId,
      trajectory.id,
      verifier.outcome,
    ]).slice(0, 24)}`;
    const artifact = await persistBaselineArtifact({
      store: input.store,
      storeDir: input.storeDir,
      tasksetId: taskset.id,
      taskId: attemptInput.task.id,
      attemptId,
      requestId,
      kind: "runtime_trace",
      payload: {
        schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
        model: attemptInput.model,
        seed: attemptInput.seed,
        attempt: attemptInput.attempt,
        trajectory,
        verifier,
        priorInfrastructureTrajectories,
      },
      timestamp: input.timestamp,
    });
    return TaskAttemptResultSchema.parse({
      schemaVersion: "openpond.taskAttempt.v1",
      id: attemptId,
      tasksetId: taskset.id,
      taskId: attemptInput.task.id,
      split: attemptInput.task.split,
      attempt: attemptInput.attempt,
      seed: attemptInput.seed,
      modelRef: attemptInput.model,
      startedAt: trajectory.startedAt,
      completedAt,
      output: {
        text: final?.content ?? "",
        trajectoryId: trajectory.id,
      },
      runtimeEventRefs: [],
      artifactRefs: [artifact.id],
      privilegedOutcomeRef: attemptInput.task.privilegedContextRef,
      infrastructureError: trajectory.infrastructureError,
      costUsd: null,
      latencyMs: elapsedMilliseconds(trajectory.startedAt, completedAt),
      userInterventions: 0,
      metadata: {
        requestId,
        execution: "taskset_baseline_tool_loop",
        trajectoryId: trajectory.id,
        worldId: trajectory.worldId,
        toolContractHash: trajectory.toolContractHash,
        verifierOutcome: verifier.outcome,
        verifierReward: verifier.reward,
        verifierRewardEligible: verifier.rewardEligible,
        infrastructureRetryAttempt:
          trajectory.metadata.infrastructureRetryAttempt,
        priorInfrastructureErrors:
          trajectory.metadata.priorInfrastructureErrors,
      },
    });
  } finally {
    clearTimeout(timer);
    attemptInput.signal?.removeEventListener("abort", abortFromParent);
  }
}

async function runTextAttempt(input: {
  store: SqliteStore;
  storeDir: string;
  modelText: ModelTextRunner;
  timestamp: () => string;
  resultId?: string;
  attemptInput: TrainingBaselineAttemptInput;
}) {
  const { attemptInput } = input;
  const startedAt = input.timestamp();
  const requestId = baselineRequestId(attemptInput, startedAt);
  try {
    const text = await input.modelText({
      model: attemptInput.model,
      reasoningEffort:
        attemptInput.model.providerId === "fireworks" ? "none" : null,
      signal: attemptInput.signal ?? new AbortController().signal,
      requestId,
      messages: policyMessages(attemptInput.task),
      maxOutputTokens: attemptInput.sampling?.maxOutputTokens ?? 2_048,
      temperature: attemptInput.sampling?.temperature ?? 0.8,
      topP: attemptInput.sampling?.topP ?? 0.95,
      seed: attemptInput.seed + attemptInput.attempt,
    });
    const completedAt = input.timestamp();
    const attemptId =
      input.resultId ?? `attempt_${contentHash([requestId, text]).slice(0, 24)}`;
    const artifact = await persistBaselineArtifact({
      store: input.store,
      storeDir: input.storeDir,
      tasksetId: attemptInput.tasksetId,
      taskId: attemptInput.task.id,
      attemptId,
      requestId,
      kind: "raw_model_response",
      payload: {
        model: attemptInput.model,
        seed: attemptInput.seed,
        attempt: attemptInput.attempt,
        output: { text },
        startedAt,
        completedAt,
      },
      timestamp: input.timestamp,
    });
    return TaskAttemptResultSchema.parse({
      schemaVersion: "openpond.taskAttempt.v1",
      id: attemptId,
      tasksetId: attemptInput.tasksetId,
      taskId: attemptInput.task.id,
      split: attemptInput.task.split,
      attempt: attemptInput.attempt,
      seed: attemptInput.seed,
      modelRef: attemptInput.model,
      startedAt,
      completedAt,
      output: { text },
      runtimeEventRefs: [],
      artifactRefs: [artifact.id],
      privilegedOutcomeRef: attemptInput.task.privilegedContextRef,
      infrastructureError: null,
      costUsd: null,
      latencyMs: elapsedMilliseconds(startedAt, completedAt),
      userInterventions: 0,
      metadata: { requestId, execution: "text_completion" },
    });
  } catch (error) {
    if (attemptInput.signal?.aborted) {
      throw attemptInput.signal.reason instanceof Error
        ? attemptInput.signal.reason
        : new Error("The baseline was cancelled.");
    }
    const completedAt = input.timestamp();
    const message = error instanceof Error ? error.message : String(error);
    const attemptId =
      input.resultId ?? `attempt_${contentHash([requestId, "failure"]).slice(0, 24)}`;
    const artifact = await persistBaselineArtifact({
      store: input.store,
      storeDir: input.storeDir,
      tasksetId: attemptInput.tasksetId,
      taskId: attemptInput.task.id,
      attemptId,
      requestId,
      kind: "raw_model_response",
      payload: {
        model: attemptInput.model,
        seed: attemptInput.seed,
        attempt: attemptInput.attempt,
        error: message,
        startedAt,
        completedAt,
      },
      timestamp: input.timestamp,
    });
    return TaskAttemptResultSchema.parse({
      schemaVersion: "openpond.taskAttempt.v1",
      id: attemptId,
      tasksetId: attemptInput.tasksetId,
      taskId: attemptInput.task.id,
      split: attemptInput.task.split,
      attempt: attemptInput.attempt,
      seed: attemptInput.seed,
      modelRef: attemptInput.model,
      startedAt,
      completedAt,
      output: {},
      runtimeEventRefs: [],
      artifactRefs: [artifact.id],
      privilegedOutcomeRef: null,
      infrastructureError: message,
      costUsd: null,
      latencyMs: elapsedMilliseconds(startedAt, completedAt),
      userInterventions: 0,
      metadata: { requestId, execution: "text_completion" },
    });
  }
}

function policyMessages(
  task: TaskDataRecord,
): Array<{ role: "system" | "user"; content: string }> {
  const messages = Array.isArray(task.input.messages)
    ? task.input.messages.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const message = value as Record<string, unknown>;
        if (
          (message.role !== "system" && message.role !== "user")
          || typeof message.content !== "string"
          || !message.content.trim()
        ) {
          return [];
        }
        return [{
          role: message.role as "system" | "user",
          content: message.content,
        }];
      })
    : [];
  if (messages.length) return messages;
  if (typeof task.input.prompt === "string" && task.input.prompt.trim()) {
    return [{ role: "user", content: task.input.prompt }];
  }
  throw new Error(`Baseline task ${task.id} has no policy-visible prompt.`);
}

async function persistBaselineArtifact(input: {
  store: SqliteStore;
  storeDir: string;
  tasksetId: string;
  taskId: string;
  attemptId: string;
  requestId: string;
  kind: "raw_model_response" | "runtime_trace";
  payload: Record<string, unknown>;
  timestamp: () => string;
}) {
  const directory = path.join(
    input.storeDir,
    "training",
    "baseline-artifacts",
    input.tasksetId,
  );
  const file = path.join(directory, `${input.attemptId}.json`);
  const bytes = Buffer.from(`${JSON.stringify({
    schemaVersion: "openpond.rawBaselineArtifact.v1",
    requestId: input.requestId,
    ...input.payload,
  }, null, 2)}\n`, "utf8");
  await mkdir(directory, { recursive: true });
  await writeFile(file, bytes, { mode: 0o600 });
  const artifact = TaskAttemptArtifactSchema.parse({
    schemaVersion: "openpond.taskAttemptArtifact.v1",
    id: `attempt_artifact_${contentHash([
      input.attemptId,
      sha256(bytes),
    ]).slice(0, 24)}`,
    tasksetId: input.tasksetId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    kind: input.kind,
    path: file,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    createdAt: input.timestamp(),
    metadata: {
      requestId: input.requestId,
      localOnly: true,
      containsPrivilegedOutcome: false,
    },
  });
  return input.store.saveTaskAttemptArtifact(artifact);
}

function baselineRequestId(
  input: {
    task: TaskDataRecord;
    model: ChatModelRef;
    seed: number;
    attempt: number;
  },
  startedAt: string,
): string {
  return `training-baseline:${contentHash([
    input.task.id,
    input.model,
    input.seed,
    input.attempt,
    startedAt,
  ]).slice(0, 40)}`;
}

function elapsedMilliseconds(startedAt: string, completedAt: string): number {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}
