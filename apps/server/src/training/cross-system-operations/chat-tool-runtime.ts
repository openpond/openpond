import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CROSS_SYSTEM_TOOL_NAMES,
  isTrainingSourceRef,
  TaskAttemptResultSchema,
  type CrossSystemToolName,
  type TaskAttemptResult,
} from "@openpond/contracts";
import type { NativeModelToolResult } from "../../openpond/native-tool-calls.js";
import type { SqliteStore } from "../../store/store.js";
import { CrossSystemEnvironment } from "./environment.js";
import type { CrossSystemDifficulty, CrossSystemSplit } from "./types.js";
import { generateCrossSystemTasks, generateCrossSystemWorld } from "./world-generator.js";
import { supportsCrossSystemToolCalling } from "../local-adapter-models.js";

type ActiveAttempt = {
  environment: CrossSystemEnvironment;
  timer: ReturnType<typeof setTimeout>;
};

export function createCrossSystemChatToolRuntime(input: {
  store: SqliteStore;
  idleTimeoutMs?: number;
  gradeAttempt?: (input: {
    tasksetId: string;
    taskId: string;
    attempt: TaskAttemptResult;
  }) => Promise<{ id: string }>;
}) {
  const attempts = new Map<string, ActiveAttempt>();

  async function execute(request: {
    modelId: string;
    localProjectId: string | null;
    turnId: string;
    callId: string;
    name: string;
    args: Record<string, unknown>;
    userPrompt: string;
    taskId?: string;
    signal: AbortSignal;
  }): Promise<NativeModelToolResult> {
    if (!isCrossSystemToolName(request.name)) return failure(request, `Unknown Cross-System Operations tool ${request.name}.`);
    if (request.signal.aborted) throw request.signal.reason ?? new Error("Cross-system chat tool call cancelled.");
    const key = `${request.modelId}:${request.turnId}`;
    let active = attempts.get(key);
    if (!active) {
      const environment = await environmentForRequest(input.store, request);
      active = { environment, timer: scheduleClose(key) };
      attempts.set(key, active);
    } else {
      clearTimeout(active.timer);
      active.timer = scheduleClose(key);
    }
    try {
      const result = await active.environment.execute(request.name, request.args, request.signal);
      const evidence = active.environment.evidence.at(-1);
      return {
        toolCallId: request.callId,
        name: request.name,
        ok: true,
        contentText: JSON.stringify({
          ok: true,
          action: request.name,
          output: `Read synthetic ${request.name} data under ${CROSS_SYSTEM_TOOL_CONTRACT_HASH}.`,
          data: result,
          evidence: evidence ? { sequence: evidence.sequence, rows: evidence.rows, bytes: evidence.bytes, durationMs: evidence.durationMs, toolContractHash: evidence.toolContractHash } : null,
        }, null, 2),
        data: { result, evidence },
      };
    } catch (error) {
      return failure(request, error instanceof Error ? error.message : String(error));
    }
  }

  async function finalize(request: {
    modelId: string;
    localProjectId: string | null;
    sessionId: string;
    turnId: string;
    userPrompt: string;
    taskId: string;
    startedAt: string;
    completedAt: string;
    terminalFailure?: {
      message: string;
      failureClass: "policy_failure" | "infrastructure_failure";
    } | null;
  }): Promise<{ attemptId: string; gradeId: string; generatedTaskId: string } | null> {
    if (!input.gradeAttempt) return null;
    const key = `${request.modelId}:${request.turnId}`;
    const active = attempts.get(key);
    if (active) {
      attempts.delete(key);
      clearTimeout(active.timer);
      await active.environment.close();
    }

    const context = await attemptContextForRequest(input.store, request);
    const events = (await input.store.runtimeEventsForSession(request.sessionId))
      .filter((item) => item.turnId === request.turnId);
    const assistantText = events
      .filter((item) => item.name === "assistant.delta" && typeof item.output === "string")
      .map((item) => item.output ?? "")
      .join("")
      .trim();
    if (!assistantText && !request.terminalFailure) {
      throw new Error("The generated Cross-System Operations turn has no persisted assistant answer to grade.");
    }

    const attemptId = `attempt_chat_${request.turnId}`;
    const attempt = TaskAttemptResultSchema.parse({
      schemaVersion: "openpond.taskAttempt.v1",
      id: attemptId,
      tasksetId: context.taskset.id,
      taskId: context.authoredTask.id,
      split: context.authoredTask.split,
      attempt: 0,
      seed: context.world.seed,
      modelRef: { providerId: "local-adapter", modelId: request.modelId },
      startedAt: request.startedAt,
      completedAt: request.completedAt,
      output: assistantText ? { text: assistantText } : {},
      runtimeEventRefs: events.map((item) => item.id),
      artifactRefs: [],
      privilegedOutcomeRef: context.authoredTask.privilegedContextRef,
      infrastructureError: request.terminalFailure?.failureClass === "infrastructure_failure"
        ? request.terminalFailure.message
        : null,
      costUsd: null,
      latencyMs: Math.max(0, Date.parse(request.completedAt) - Date.parse(request.startedAt)),
      userInterventions: 0,
      metadata: {
        source: "normal_openpond_chat",
        sessionId: request.sessionId,
        turnId: request.turnId,
        generatedTaskId: context.generatedTask.id,
        ...(request.terminalFailure ? {
          terminalFailure: request.terminalFailure.message,
          terminalFailureClass: request.terminalFailure.failureClass,
        } : {}),
        toolEventRefs: events
          .filter((item) => item.name === "tool.started" || item.name === "tool.completed")
          .map((item) => item.id),
      },
    });
    const grade = await input.gradeAttempt({
      tasksetId: context.taskset.id,
      taskId: context.authoredTask.id,
      attempt,
    });
    return { attemptId, gradeId: grade.id, generatedTaskId: context.generatedTask.id };
  }

  async function close(): Promise<void> {
    const active = [...attempts.values()];
    attempts.clear();
    for (const attempt of active) {
      clearTimeout(attempt.timer);
      await attempt.environment.close();
    }
  }

  function scheduleClose(key: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const active = attempts.get(key);
      if (!active) return;
      attempts.delete(key);
      void active.environment.close();
    }, input.idleTimeoutMs ?? 120_000);
    timer.unref?.();
    return timer;
  }

  return { execute, finalize, close };
}

async function environmentForRequest(store: SqliteStore, request: { modelId: string; localProjectId: string | null; turnId: string; userPrompt: string; taskId?: string }) {
  const context = await attemptContextForRequest(store, request);
  return new CrossSystemEnvironment({
    attemptId: `chat_${request.turnId}`,
    world: context.world,
    task: context.generatedTask,
  });
}

async function attemptContextForRequest(
  store: SqliteStore,
  request: { modelId: string; localProjectId: string | null; userPrompt: string; taskId?: string },
) {
  const lineage = await store.getModelArtifactLineage(request.modelId);
  if (!lineage || lineage.status !== "imported") throw new Error("The chat model has no imported Cross-System Operations lineage.");
  const taskset = await store.getTaskset(lineage.tasksetId);
  if (!taskset || !supportsCrossSystemToolCalling(taskset)) throw new Error("The selected model is not bound to a conformed Cross-System Operations Taskset.");
  requireSourceProject(
    taskset.sourceRefs.filter(isTrainingSourceRef),
    request.localProjectId,
  );
  const specs = Array.isArray(taskset.metadata.worldSpecs) ? taskset.metadata.worldSpecs.flatMap(parseWorldSpec) : [];
  if (!specs.length) throw new Error("The Cross-System Operations Taskset has no versioned synthetic world specs.");
  const worlds = specs.map(generateCrossSystemWorld);
  const tasks = worlds.flatMap(generateCrossSystemTasks);
  const generatedTask = resolveGeneratedTask(taskset.tasks, tasks, request);
  if (!generatedTask) throw new Error("Use one generated Cross-System Operations question from this Taskset for constrained chat testing.");
  const authoredTask = taskset.tasks.find((candidate) => (
    candidate.id === request.taskId || candidate.metadata.taskId === generatedTask.id
  ));
  if (!authoredTask) throw new Error(`Generated Cross-System Operations task ${generatedTask.id} has no authored Taskset record.`);
  const world = worlds.find((candidate) => candidate.id === generatedTask.worldId);
  if (!world) throw new Error("Generated chat task has no matching synthetic world.");
  return { taskset, authoredTask, generatedTask, world };
}

function requireSourceProject(
  sources: Array<{ workspaceId: string | null }>,
  localProjectId: string | null,
): void {
  const projectIds = new Set(sources.flatMap((source) => {
    const id = source.workspaceId?.trim();
    return id ? [id] : [];
  }));
  if (projectIds.size > 1) {
    throw new Error("The model Taskset spans multiple source projects and cannot be used for constrained Cross-System chat.");
  }
  const sourceProjectId = projectIds.values().next().value;
  if (sourceProjectId && sourceProjectId !== localProjectId) {
    throw new Error("The chat session is not attached to this model Taskset's source Cross-System Operations project.");
  }
}

function resolveGeneratedTask(
  authoredTasks: Array<{ id: string; input: { prompt?: string }; metadata: Record<string, unknown> }>,
  generatedTasks: ReturnType<typeof generateCrossSystemTasks>,
  request: { userPrompt: string; taskId?: string },
) {
  if (request.taskId) {
    const authored = authoredTasks.find((task) => task.id === request.taskId || task.metadata.taskId === request.taskId);
    const generatedId = authored && typeof authored.metadata.taskId === "string" ? authored.metadata.taskId : request.taskId;
    const selected = generatedTasks.find((task) => task.id === generatedId);
    if (!selected) throw new Error(`Generated Cross-System Operations task ${request.taskId} is not present in this model's Taskset worlds.`);
    return selected;
  }
  const exactAuthored = authoredTasks.filter((task) => task.input.prompt === request.userPrompt);
  if (exactAuthored.length > 1) throw ambiguousTaskPrompt();
  const authored = exactAuthored[0]
    ?? uniqueMatch(authoredTasks.filter((task) => typeof task.input.prompt === "string" && request.userPrompt.includes(task.input.prompt)));
  const sourceTaskId = authored && typeof authored.metadata.taskId === "string" ? authored.metadata.taskId : null;
  if (sourceTaskId) return generatedTasks.find((task) => task.id === sourceTaskId);
  const exactGenerated = generatedTasks.filter((task) => task.prompt === request.userPrompt);
  if (exactGenerated.length > 1) throw ambiguousTaskPrompt();
  return exactGenerated[0] ?? uniqueMatch(generatedTasks.filter((task) => request.userPrompt.includes(task.prompt)));
}

function uniqueMatch<T>(matches: T[]): T | undefined {
  if (matches.length > 1) throw ambiguousTaskPrompt();
  return matches[0];
}

function ambiguousTaskPrompt(): Error {
  return new Error("This generated question exists in multiple synthetic worlds. Select its generated task ID before running the constrained chat.");
}

function parseWorldSpec(value: unknown): Array<{ seed: number; split: CrossSystemSplit; difficulty: CrossSystemDifficulty }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const split = record.split === "train" || record.split === "validation" || record.split === "frozen_eval" ? record.split : null;
  const difficulty = record.difficulty === "easy" || record.difficulty === "medium" || record.difficulty === "hard" ? record.difficulty : null;
  return typeof record.seed === "number" && Number.isInteger(record.seed) && split && difficulty ? [{ seed: record.seed, split, difficulty }] : [];
}

function failure(request: { callId: string; name: string }, message: string): NativeModelToolResult {
  return {
    toolCallId: request.callId,
    name: request.name,
    ok: false,
    contentText: JSON.stringify({ ok: false, action: request.name, output: message, toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH }, null, 2),
  };
}

function isCrossSystemToolName(value: string): value is CrossSystemToolName {
  return (CROSS_SYSTEM_TOOL_NAMES as readonly string[]).includes(value);
}
