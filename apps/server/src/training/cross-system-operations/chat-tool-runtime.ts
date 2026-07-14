import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CROSS_SYSTEM_TOOL_NAMES,
  type CrossSystemToolName,
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

export function createCrossSystemChatToolRuntime(input: { store: SqliteStore; idleTimeoutMs?: number }) {
  const attempts = new Map<string, ActiveAttempt>();

  async function execute(request: {
    modelId: string;
    turnId: string;
    callId: string;
    name: string;
    args: Record<string, unknown>;
    userPrompt: string;
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

  return { execute, close };
}

async function environmentForRequest(store: SqliteStore, request: { modelId: string; turnId: string; userPrompt: string }) {
  const lineage = await store.getModelArtifactLineage(request.modelId);
  if (!lineage || lineage.status !== "imported") throw new Error("The chat model has no imported Cross-System Operations lineage.");
  const taskset = await store.getTaskset(lineage.tasksetId);
  if (!taskset || !supportsCrossSystemToolCalling(taskset)) throw new Error("The selected model is not bound to a conformed Cross-System Operations Taskset.");
  const specs = Array.isArray(taskset.metadata.worldSpecs) ? taskset.metadata.worldSpecs.flatMap(parseWorldSpec) : [];
  if (!specs.length) throw new Error("The Cross-System Operations Taskset has no versioned synthetic world specs.");
  const worlds = specs.map(generateCrossSystemWorld);
  const tasks = worlds.flatMap(generateCrossSystemTasks);
  const authoredTask = taskset.tasks.find((task) => task.input.prompt === request.userPrompt)
    ?? taskset.tasks.find((task) => typeof task.input.prompt === "string" && request.userPrompt.includes(task.input.prompt));
  const sourceTaskId = authoredTask && typeof authoredTask.metadata.taskId === "string" ? authoredTask.metadata.taskId : null;
  const generatedTask = (sourceTaskId ? tasks.find((task) => task.id === sourceTaskId) : null)
    ?? tasks.find((task) => task.prompt === request.userPrompt)
    ?? tasks.find((task) => request.userPrompt.includes(task.prompt));
  if (!generatedTask) throw new Error("Use one generated Cross-System Operations question from this Taskset for constrained chat testing.");
  const world = worlds.find((candidate) => candidate.id === generatedTask.worldId);
  if (!world) throw new Error("Generated chat task has no matching synthetic world.");
  return new CrossSystemEnvironment({ attemptId: `chat_${request.turnId}`, world, task: generatedTask });
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
