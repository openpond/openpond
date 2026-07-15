import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
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
  const tasks = taskset.metadata.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH
    ? generatedChatTasks(taskset)
    : [];
  return {
    model: { providerId: "local-adapter", modelId },
    tasksetId: taskset.id,
    tasksetName: taskset.name,
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
    crossSystemTaskId: task.generatedTaskId,
    trainingTasksetId: handoff.tasksetId,
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
  if (model.providerId !== "local-adapter" || !connection) return;
  applyBootstrap(await loadBootstrap(connection));
}

function generatedChatTasks(taskset: Taskset): TrainingModelChatTask[] {
  const seen = new Set<string>();
  return taskset.tasks.flatMap((task) => {
    const generatedTaskId = typeof task.metadata.taskId === "string"
      ? task.metadata.taskId.trim()
      : "";
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
  const projectIds = new Set(taskset.sourceRefs.flatMap((source) => {
    const id = source.workspaceId?.trim();
    return id ? [id] : [];
  }));
  return projectIds.size === 1 ? (projectIds.values().next().value ?? null) : null;
}

function boundedTaskIndex(handoff: TrainingModelChatHandoff, index: number): number {
  if (!handoff.tasks.length) return 0;
  return Math.max(0, Math.min(Math.trunc(index), handoff.tasks.length - 1));
}
