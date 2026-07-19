import {
  CrossSystemWorldSpecSchema,
  type TaskDataRecord,
  type Taskset,
} from "@openpond/contracts";
import { generateCrossSystemTasks, generateCrossSystemWorld } from "./world-generator.js";
import type { CrossSystemTask, CrossSystemWorld } from "./types.js";

export type CrossSystemTaskContext = {
  taskset: Taskset;
  authoredTask: TaskDataRecord;
  generatedTask: CrossSystemTask;
  world: CrossSystemWorld;
};

export function resolveCrossSystemTask(
  taskset: Taskset,
  input: { taskId: string; prompt?: string | null },
): CrossSystemTaskContext {
  const { worlds, generatedTasks } = generatedCrossSystemTaskset(taskset);
  const authoredTask = taskset.tasks.find((task) =>
    task.id === input.taskId || task.metadata.taskId === input.taskId,
  );
  if (!authoredTask) {
    throw new Error(`Task ${input.taskId} does not resolve to an immutable Cross-System Taskset row.`);
  }
  const generatedId = typeof authoredTask.metadata.taskId === "string"
    ? authoredTask.metadata.taskId
    : authoredTask.id;
  const generatedTask = generatedTasks.find((task) => task.id === generatedId);
  if (!generatedTask || generatedTask.split !== authoredTask.split) {
    throw new Error(`Authored task ${authoredTask.id} has no generated ${authoredTask.split} world task.`);
  }
  if (input.prompt && input.prompt !== generatedTask.prompt && input.prompt !== authoredTask.input.prompt) {
    throw new Error("Policy prompt does not match the immutable Cross-System Taskset row.");
  }
  const world = worlds.find((candidate) => candidate.id === generatedTask.worldId);
  if (!world) throw new Error(`Generated task ${generatedTask.id} has no deterministic world.`);
  return { taskset, authoredTask, generatedTask, world };
}

export function resolveCrossSystemTrainTask(
  taskset: Taskset,
  input: { rowId: string; prompt?: string | null },
): CrossSystemTaskContext {
  const context = resolveCrossSystemTask(taskset, {
    taskId: input.rowId,
    prompt: input.prompt,
  });
  if (context.authoredTask.split !== "train" || context.generatedTask.split !== "train") {
    throw new Error(`Fireworks row ${input.rowId} does not resolve to an approved train task.`);
  }
  return context;
}

function generatedCrossSystemTaskset(taskset: Taskset): {
  worlds: CrossSystemWorld[];
  generatedTasks: CrossSystemTask[];
} {
  const specs = Array.isArray(taskset.metadata.worldSpecs)
    ? taskset.metadata.worldSpecs.flatMap((value) => {
        const result = CrossSystemWorldSpecSchema.safeParse(value);
        return result.success ? [result.data] : [];
      })
    : [];
  if (!specs.length) {
    throw new Error("The Taskset has no versioned Cross-System Operations world specs.");
  }
  const worlds = specs.map(generateCrossSystemWorld);
  const generatedTasks = worlds.flatMap(generateCrossSystemTasks);
  return { worlds, generatedTasks };
}
