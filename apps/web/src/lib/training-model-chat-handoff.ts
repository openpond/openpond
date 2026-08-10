import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  isTrainingSourceRef,
  type ChatModelRef,
  type Taskset,
} from "@openpond/contracts";
import type { ClientConnection } from "../api";

export type TrainingModelChatTask = {
  authoredTaskId: string;
  generatedTaskId: string;
  prompt: string;
  split: Taskset["tasks"][number]["split"];
};

export type TrainingModelChatHandoff = {
  model: ChatModelRef;
  tasksetId: string;
  tasksetName: string;
  taskRuntime: "cross_system" | "harness" | null;
  sourceProjectId: string | null;
  tasks: TrainingModelChatTask[];
  selectedTaskIndex: number;
  sessionId: string | null;
};

export function buildTrainingModelChatHandoff({
  modelId,
  taskset,
}: {
  modelId: string;
  taskset: Taskset;
}): TrainingModelChatHandoff {
  const taskRuntime =
    taskset.metadata.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH
      ? "cross_system"
      : taskset.environment.kind === "stateful_harness"
        && Boolean(taskset.environment.actionBindings?.length)
        ? "harness"
        : null;
  const tasks = taskRuntime ? generatedChatTasks(taskset, taskRuntime) : [];
  return {
    model: { providerId: "openpond", modelId },
    tasksetId: taskset.id,
    tasksetName: taskset.name,
    taskRuntime,
    sourceProjectId: uniqueSourceProjectId(taskset),
    tasks,
    selectedTaskIndex: 0,
    sessionId: null,
  };
}

export function selectedTrainingModelChatTask(
  handoff: TrainingModelChatHandoff | null,
): TrainingModelChatTask | null {
  if (!handoff?.tasks.length) return null;
  return handoff.tasks[boundedTaskIndex(handoff, handoff.selectedTaskIndex)] ?? null;
}

export function selectTrainingModelChatTask(
  handoff: TrainingModelChatHandoff,
  index: number,
): TrainingModelChatHandoff {
  return { ...handoff, selectedTaskIndex: boundedTaskIndex(handoff, index) };
}

export function advanceTrainingModelChatTask(
  handoff: TrainingModelChatHandoff,
): TrainingModelChatHandoff {
  return selectTrainingModelChatTask(handoff, handoff.selectedTaskIndex + 1);
}

export function trainingModelChatTurnMetadata(
  handoff: TrainingModelChatHandoff | null,
  prompt: string,
  selectedLocalProjectId: string | null,
): Record<string, unknown> | null {
  if (!handoff) return null;
  if (trainingModelChatProjectError(handoff, selectedLocalProjectId)) return null;
  const task = selectedTrainingModelChatTask(handoff);
  if (!task || prompt.trim() !== task.prompt.trim()) return null;
  return {
    ...(handoff.taskRuntime === "cross_system"
      ? { crossSystemTaskId: task.generatedTaskId }
      : { trainingHarnessTaskId: task.generatedTaskId }),
    trainingTasksetId: handoff.tasksetId,
    trainingTasksetName: handoff.tasksetName,
    source: "training_model_chat_handoff",
  };
}

export function trainingModelChatProjectError(
  handoff: TrainingModelChatHandoff | null,
  selectedLocalProjectId: string | null,
): string | null {
  if (!handoff?.sourceProjectId || handoff.sourceProjectId === selectedLocalProjectId) return null;
  return "This generated Taskset question is bound to its source Cross-System Operations project. Return to Models and choose Chat again to restore the correct project.";
}

export async function refreshModelCatalogBeforeChat<Payload>({
  model,
  connection,
  loadBootstrap,
  applyBootstrap,
}: {
  model: ChatModelRef;
  connection: ClientConnection | null;
  loadBootstrap: (connection: ClientConnection) => Promise<Payload>;
  applyBootstrap: (payload: Payload) => void;
}): Promise<void> {
  if (model.providerId !== "openpond" || !connection) return;
  applyBootstrap(await loadBootstrap(connection));
}

function generatedChatTasks(
  taskset: Taskset,
  runtime: NonNullable<TrainingModelChatHandoff["taskRuntime"]>,
): TrainingModelChatTask[] {
  const seen = new Set<string>();
  return taskset.tasks.flatMap((task) => {
    const rawTaskId =
      runtime === "cross_system"
        ? task.metadata.taskId
        : task.metadata.caseId;
    const generatedTaskId =
      typeof rawTaskId === "string" ? rawTaskId.trim() : "";
    const prompt = typeof task.input.prompt === "string" ? task.input.prompt.trim() : "";
    if (!generatedTaskId || !prompt || seen.has(generatedTaskId)) return [];
    seen.add(generatedTaskId);
    return [{
      authoredTaskId: task.id,
      generatedTaskId,
      prompt,
      split: task.split,
    }];
  });
}

function uniqueSourceProjectId(taskset: Taskset): string | null {
  const projectIds = new Set(taskset.sourceRefs.filter(isTrainingSourceRef).flatMap((source) => {
    const id = source.workspaceId?.trim();
    return id ? [id] : [];
  }));
  return projectIds.size === 1 ? (projectIds.values().next().value ?? null) : null;
}

function boundedTaskIndex(handoff: TrainingModelChatHandoff, index: number): number {
  if (!handoff.tasks.length) return 0;
  return Math.max(0, Math.min(Math.trunc(index), handoff.tasks.length - 1));
}
