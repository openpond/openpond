import { TaskAttemptResultSchema, type TaskAttemptResult, type TaskDataRecord, type Taskset } from "@openpond/contracts";
import { contentHash } from "./hashing.js";

export type LocalTaskHandler = (input: { task: TaskDataRecord; seed: number }) => Promise<Record<string, unknown>>;

export async function runTasksetLocally(input: { taskset: Taskset; split?: "validation" | "test" | "frozen_eval"; seed?: number; handler: LocalTaskHandler; now?: () => string }): Promise<TaskAttemptResult[]> {
  const split = input.split ?? "validation";
  const seed = input.seed ?? 0;
  const now = input.now ?? (() => new Date().toISOString());
  const results: TaskAttemptResult[] = [];
  for (const task of input.taskset.tasks.filter((item) => item.split === split)) {
    const startedAt = now();
    try {
      const output = await input.handler({ task, seed });
      results.push(TaskAttemptResultSchema.parse({ schemaVersion: "openpond.taskAttempt.v1", id: `attempt_${contentHash([task.id, seed, output]).slice(0, 24)}`, tasksetId: input.taskset.id, taskId: task.id, split, attempt: 0, seed, modelRef: null, startedAt, completedAt: now(), output, runtimeEventRefs: [], artifactRefs: [], privilegedOutcomeRef: task.privilegedContextRef, infrastructureError: null, costUsd: null, latencyMs: 0, userInterventions: 0, metadata: { execution: "local" } }));
    } catch (error) {
      results.push(TaskAttemptResultSchema.parse({ schemaVersion: "openpond.taskAttempt.v1", id: `attempt_${contentHash([task.id, seed, "failure"]).slice(0, 24)}`, tasksetId: input.taskset.id, taskId: task.id, split, attempt: 0, seed, modelRef: null, startedAt, completedAt: now(), output: {}, runtimeEventRefs: [], artifactRefs: [], privilegedOutcomeRef: null, infrastructureError: error instanceof Error ? error.message : String(error), costUsd: null, latencyMs: 0, userInterventions: 0, metadata: { execution: "local" } }));
    }
  }
  return results;
}
