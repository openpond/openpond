import type { HostedChatMessage } from "@openpond/cloud";
import {
  TaskAttemptResultSchema,
  type GradeResult,
  type RolloutTrajectoryReceipt,
  type RftRecipe,
  type TaskAttemptResult,
  type TaskDataRecord,
  type Taskset,
  type TrainingJob,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type { InitRequest } from "eval-protocol";
import { extractFinalAnswer } from "./exact-answer.js";

type PolicyDelta = {
  text: string;
  toolCalls: unknown[];
};

export async function resolveExactAnswerTask(input: {
  taskset: Taskset;
  taskId: string;
  prompt: string | null;
  resolveTask?: (input: {
    tasksetId: string;
    taskId: string;
    split: "train";
  }) => Promise<TaskDataRecord>;
}): Promise<TaskDataRecord> {
  const task = input.taskset.tasks.find((candidate) =>
    candidate.id === input.taskId && candidate.split === "train")
    ?? await input.resolveTask?.({
      tasksetId: input.taskset.id,
      taskId: input.taskId,
      split: "train",
    });
  if (!task || task.split !== "train") {
    throw new Error(`Dataset RFT task was not found: ${input.taskId}`);
  }
  if (!task.expectedOutput) {
    throw new Error("Dataset exact-answer RFT requires a privileged expected answer.");
  }
  const authoredPrompt = taskPrompt(task);
  if (
    input.prompt
    && normalizePrompt(input.prompt) !== normalizePrompt(authoredPrompt)
  ) {
    throw new Error("The provider rollout prompt does not match the selected Dataset task.");
  }
  return task;
}

export async function runExactAnswerRollout(input: {
  init: InitRequest;
  recipe: RftRecipe;
  job: TrainingJob;
  tasksetId: string;
  task: TaskDataRecord;
  correlationId: string;
  policyModelId: string;
  streamPolicy: (input: {
    messages: HostedChatMessage[];
    signal: AbortSignal;
  }) => AsyncIterable<PolicyDelta>;
  resolveGrade?: (input: {
    tasksetId: string;
    taskId: string;
    attempt: TaskAttemptResult;
  }) => Promise<GradeResult>;
  timestamp: () => string;
  providerTrace: Record<string, unknown>;
}): Promise<{
  trajectory: NonNullable<RolloutTrajectoryReceipt["trajectory"]>;
  verifier: NonNullable<RolloutTrajectoryReceipt["verifier"]>;
  reward: RolloutTrajectoryReceipt["reward"];
  failureClass: RolloutTrajectoryReceipt["failureClass"];
}> {
  if (!input.resolveGrade) {
    throw new Error("Dataset exact-answer grading is unavailable.");
  }
  const startedAt = input.timestamp();
  const startedMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("RFT rollout exceeded its bounded wall time.")),
    input.recipe.resourceLimits.wallTimeMs,
  );
  timer.unref?.();
  let responseText = "";
  try {
    for await (const delta of input.streamPolicy({
      messages: hostedPolicyMessages(input.init.messages),
      signal: controller.signal,
    })) {
      if (delta.toolCalls.length) {
        throw new Error("The tool-free Dataset environment received a policy tool call.");
      }
      responseText += delta.text;
    }
  } finally {
    clearTimeout(timer);
  }
  const completedAt = input.timestamp();
  const attempt = TaskAttemptResultSchema.parse({
    schemaVersion: "openpond.taskAttempt.v1",
    id: `rft_attempt_${contentHash([
      input.job.id,
      input.init.metadata.rollout_id,
    ]).slice(0, 24)}`,
    tasksetId: input.tasksetId,
    taskId: input.task.id,
    split: "train",
    attempt: 0,
    seed: input.recipe.rollout.seed,
    modelRef: {
      providerId: "fireworks",
      modelId: input.policyModelId,
    },
    startedAt,
    completedAt,
    output: { text: responseText },
    runtimeEventRefs: [],
    artifactRefs: [],
    privilegedOutcomeRef: input.task.privilegedContextRef,
    infrastructureError: null,
    costUsd: null,
    latencyMs: Math.max(0, Date.now() - startedMs),
    userInterventions: 0,
    metadata: {
      execution: "fireworks_remote_exact_answer_environment",
      correlationId: input.correlationId,
      providerTrace: input.providerTrace,
    },
  });
  const grade = await input.resolveGrade({
    tasksetId: input.tasksetId,
    taskId: input.task.id,
    attempt,
  });
  const extractedAnswer = extractFinalAnswer(responseText);
  const eligible = grade.score !== null;
  const score = eligible ? Math.max(0, Math.min(1, grade.score!)) : null;
  const outcome = grade.passed
    ? "correct" as const
    : extractedAnswer === null
      ? "parse_failure" as const
      : "incorrect" as const;
  return {
    trajectory: {
      schemaVersion: "openpond.singleTurnPolicyTrajectory.v1",
      id: `exact_rft_${contentHash([
        input.job.id,
        input.init.metadata.rollout_id,
      ]).slice(0, 24)}`,
      taskId: input.task.id,
      status: "completed",
      promptHash: contentHash(taskPrompt(input.task)),
      responseText,
      infrastructureError: null,
      startedAt,
      completedAt,
      metadata: {
        execution: "fireworks_remote_exact_answer_environment",
        correlationId: input.correlationId,
      },
    },
    verifier: {
      schemaVersion: "openpond.exactAnswerVerifierResult.v1",
      outcome,
      graderSetHash: grade.graderSetHash,
      score,
      passed: grade.passed,
      rewardEligible: eligible,
      expectedAnswerHash: contentHash(input.task.expectedOutput),
      extractedAnswer,
      feedback: grade.feedback,
    },
    reward: {
      eligible,
      raw: score,
      normalized: score,
      components: Object.fromEntries(
        grade.components.map((component) => [
          component.graderId,
          component.score,
        ]),
      ),
    },
    failureClass: grade.passed
      ? null
      : outcome === "parse_failure"
        ? "parse_failure"
        : "policy_failure",
  };
}

function hostedPolicyMessages(
  messages: InitRequest["messages"],
): HostedChatMessage[] {
  return (messages ?? []).map((message) => {
    if (
      message.role !== "system"
      && message.role !== "user"
      && message.role !== "assistant"
      && message.role !== "tool"
    ) {
      throw new Error(`Unsupported Dataset rollout message role ${message.role}.`);
    }
    return {
      role: message.role,
      content: typeof message.content === "string" ? message.content : "",
    };
  });
}

function taskPrompt(task: TaskDataRecord): string {
  if (typeof task.input.prompt === "string" && task.input.prompt.trim()) {
    return task.input.prompt;
  }
  const messages = Array.isArray(task.input.messages)
    ? task.input.messages
    : [];
  const prompt = messages.flatMap((value) => {
    const message = record(value);
    return message.role === "user" && typeof message.content === "string"
      ? [message.content]
      : [];
  }).at(-1);
  if (!prompt) throw new Error("Dataset RFT task has no user prompt.");
  return prompt;
}

function normalizePrompt(value: string): string {
  return value.normalize("NFC").trim().replace(/\r\n/g, "\n");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
