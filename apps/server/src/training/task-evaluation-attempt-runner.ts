import {
  CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  TaskAttemptResultSchema,
  type ChatModelRef,
  type CodexReasoningEffort,
  type CrossSystemTrajectory,
  type CrossSystemVerifierResult,
  type TaskDataRecord,
  type Taskset,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import { persistJsonTaskAttemptArtifact } from "./task-attempt-artifact-service.js";
import {
  resolveCrossSystemTask,
  runCrossSystemRollout,
  verifyCrossSystemTrajectory,
  type CrossSystemModelStream,
} from "./cross-system-operations/index.js";
import {
  runTasksetWorkAttempt,
  type TasksetWorkAttemptRuntime,
  type TasksetWorkModelStream,
} from "./taskset-work-attempt-runner.js";

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

type TrainingEvaluationAttemptInput = {
  tasksetId: string;
  task: TaskDataRecord;
  model: ChatModelRef;
  reasoningEffort?: CodexReasoningEffort | "none" | null;
  seed: number;
  attempt: number;
  sampling?: {
    maxOutputTokens: number;
    temperature: number;
    topP: number;
  };
  signal?: AbortSignal;
};

export async function runPostTrainingEvaluationAttempt(input: {
  store: SqliteStore;
  storeDir: string;
  modelText: ModelTextRunner;
  crossSystemStream: CrossSystemModelStream;
  work?: {
    stream: TasksetWorkModelStream;
    runtime: TasksetWorkAttemptRuntime;
    additionalToolDefinitions?: import("../openpond/model-tool-registry.js").ModelToolDefinition[];
    validateRequiredOutput?: Parameters<
      typeof runTasksetWorkAttempt
    >[0]["validateRequiredOutput"];
  };
  timestamp?: () => string;
  resultId?: string;
  harnessInstructionContext?: string;
  attemptInput: TrainingEvaluationAttemptInput;
}) {
  const timestamp = input.timestamp ?? (() => new Date().toISOString());
  const taskset = await input.store.getTaskset(input.attemptInput.tasksetId);
  if (!taskset) {
    throw new Error(`Taskset ${input.attemptInput.tasksetId} was not found.`);
  }
  if (taskset.environment.kind === "work") {
    if (!input.work) {
      throw new Error(
        "Taskset Work execution is not configured for this evaluator.",
      );
    }
    return runTasksetWorkAttempt({
      store: input.store,
      storeDir: input.storeDir,
      taskset,
      task: input.attemptInput.task,
      model: input.attemptInput.model,
      reasoningEffort: input.attemptInput.reasoningEffort,
      seed: input.attemptInput.seed,
      attempt: input.attemptInput.attempt,
      sampling: input.attemptInput.sampling,
      signal: input.attemptInput.signal,
      stream: input.work.stream,
      runtime: input.work.runtime,
      timestamp: input.timestamp,
      resultId: input.resultId,
      harnessInstructionContext: input.harnessInstructionContext,
      validateRequiredOutput: input.work.validateRequiredOutput,
      additionalToolDefinitions: input.work.additionalToolDefinitions,
    });
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
  crossSystemStream: CrossSystemModelStream;
  timestamp: () => string;
  resultId?: string;
  taskset: Taskset;
  attemptInput: TrainingEvaluationAttemptInput;
}) {
  const { attemptInput, taskset } = input;
  const startedAt = input.timestamp();
  const requestId = evaluationRequestId(attemptInput, startedAt);
  const context = resolveCrossSystemTask(taskset, {
    taskId: attemptInput.task.id,
    prompt: typeof attemptInput.task.input.prompt === "string"
      ? attemptInput.task.input.prompt
      : null,
  });
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(
    attemptInput.signal?.reason ?? new Error("The evaluation was cancelled."),
  );
  attemptInput.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeoutMs = Math.max(
    1,
    Math.min(taskset.environment.defaultTimeoutMs, 10 * 60_000),
  );
  const timer = setTimeout(
    () => controller.abort(new Error(`Cross-System evaluation exceeded ${timeoutMs} ms.`)),
    timeoutMs,
  );
  timer.unref?.();
  try {
    const priorInfrastructureTrajectories: CrossSystemTrajectory[] = [];
    let trajectory: CrossSystemTrajectory | null = null;
    let verifier: CrossSystemVerifierResult | null = null;
    for (let retry = 0; retry <= 1; retry += 1) {
      const retryTrajectory = await runCrossSystemRollout({
        world: context.world,
        task: context.generatedTask,
        model: attemptInput.model,
        reasoningEffort: null,
        stream: input.crossSystemStream,
        signal: controller.signal,
        trajectoryId: `cso_post_training_eval_${contentHash([
          requestId,
          retry,
        ]).slice(0, 24)}`,
        metadata: {
          evaluation: "post_training",
          execution: "post_training_evaluation_tool_loop",
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
      trajectory = retryTrajectory;
      verifier = verifyCrossSystemTrajectory({
        task: context.generatedTask,
        trajectory: retryTrajectory,
      });
      if (verifier.outcome !== "infrastructure_failure" || retry === 1) break;
      priorInfrastructureTrajectories.push(retryTrajectory);
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
    const artifact = await persistJsonTaskAttemptArtifact({
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
        execution: "post_training_evaluation_tool_loop",
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
  attemptInput: TrainingEvaluationAttemptInput;
}) {
  const { attemptInput } = input;
  const startedAt = input.timestamp();
  const requestId = evaluationRequestId(attemptInput, startedAt);
  try {
    const text = await input.modelText({
      model: attemptInput.model,
      reasoningEffort: null,
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
    const artifact = await persistJsonTaskAttemptArtifact({
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
        : new Error("The evaluation was cancelled.");
    }
    const completedAt = input.timestamp();
    const message = error instanceof Error ? error.message : String(error);
    const attemptId =
      input.resultId ?? `attempt_${contentHash([requestId, "failure"]).slice(0, 24)}`;
    const artifact = await persistJsonTaskAttemptArtifact({
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
  throw new Error(`Evaluation task ${task.id} has no policy-visible prompt.`);
}

function evaluationRequestId(
  input: {
    task: TaskDataRecord;
    model: ChatModelRef;
    seed: number;
    attempt: number;
  },
  startedAt: string,
): string {
  return `post-training-evaluation:${contentHash([
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
