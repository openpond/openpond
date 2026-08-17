import {
  ChatModelRefSchema,
  type ChatModelRef,
  type TaskAttemptResult,
} from "@openpond/contracts";

type ObservationReceiptTask = Record<string, unknown> & { promptId: number };

export function resolveObservationModel(env: NodeJS.ProcessEnv): ChatModelRef {
  const providerId = env.OPENPOND_REFINER_OBSERVATION_MODEL_PROVIDER?.trim();
  const modelId = env.OPENPOND_REFINER_OBSERVATION_MODEL_ID?.trim();
  if (Boolean(providerId) !== Boolean(modelId)) {
    throw new Error(
      "OPENPOND_REFINER_OBSERVATION_MODEL_PROVIDER and OPENPOND_REFINER_OBSERVATION_MODEL_ID must be set together.",
    );
  }
  return ChatModelRefSchema.parse(providerId && modelId
    ? { providerId, modelId }
    : { providerId: "openpond", modelId: "openpond-chat" });
}

export function reusableCanonicalAttempt(
  attempts: TaskAttemptResult[],
  sourceTaskId: string,
  model: ChatModelRef,
): TaskAttemptResult | null {
  return attempts.filter((candidate) =>
    candidate.taskId === sourceTaskId
    && rewardStatus(candidate.metadata.portableRewardReceipt) === "scored"
    && candidate.modelRef?.providerId === model.providerId
    && candidate.modelRef.modelId === model.modelId
  ).at(-1) ?? null;
}

export function priorUnscorableAttemptIds(
  attempts: TaskAttemptResult[],
  sourceTaskId: string,
  selectedAttemptId: string,
): string[] {
  return attempts.filter((candidate) =>
    candidate.taskId === sourceTaskId
    && candidate.id !== selectedAttemptId
    && rewardStatus(candidate.metadata.portableRewardReceipt) === "unscorable"
  ).map((candidate) => candidate.id);
}

export function completedObservationPromptIds(tasks: ObservationReceiptTask[]): Set<number> {
  return new Set(tasks.filter((task) => observationTaskRewardStatus(task) === "scored").map((task) => task.promptId));
}

export function upsertObservationTask(
  tasks: ObservationReceiptTask[],
  task: ObservationReceiptTask,
): void {
  const priorIndex = tasks.findIndex((candidate) => candidate.promptId === task.promptId);
  if (priorIndex === -1) tasks.push(task);
  else tasks.splice(priorIndex, 1, task);
}

export function observationBatchComplete(
  selectedTaskIds: number[],
  tasks: ObservationReceiptTask[],
): boolean {
  const completed = completedObservationPromptIds(tasks);
  return selectedTaskIds.every((promptId) => completed.has(promptId));
}

function observationTaskRewardStatus(task: ObservationReceiptTask): string | null {
  return rewardStatus(recordValue(recordValue(task.canonical).rewardReceipt));
}

function rewardStatus(value: unknown): string | null {
  const status = recordValue(value).status;
  return typeof status === "string" ? status : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
