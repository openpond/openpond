import {
  type BaselineReport,
  type ChatModelRef,
  type GradeResult,
  type TaskAttemptResult,
  type TaskDataRecord,
  type Taskset,
} from "@openpond/contracts";
import { gradeAttempt, type CustomVerifierRunner, type ModelJudgeRunner } from "./graders.js";
import { contentHash } from "./hashing.js";

export type BaselineAttemptRunner = (input: {
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
}) => Promise<TaskAttemptResult>;

export type BaselineGradeRunner = (input: {
  task: TaskDataRecord;
  attempt: TaskAttemptResult;
  graders: Taskset["graders"];
  modelJudge?: ModelJudgeRunner;
  customVerifier?: CustomVerifierRunner;
  now: () => string;
}) => Promise<GradeResult>;

export type BaselineExecution = {
  report: BaselineReport;
  attempts: TaskAttemptResult[];
  grades: GradeResult[];
};

export async function runBaseline(input: {
  taskset: Taskset;
  tasks?: TaskDataRecord[];
  models: ChatModelRef[];
  seeds: number[];
  attemptsPerTask: number;
  concurrency?: number;
  sampling?: {
    maxOutputTokens: number;
    temperature: number;
    topP: number;
  };
  runAttempt: BaselineAttemptRunner;
  gradeAttempt?: BaselineGradeRunner;
  modelJudge?: ModelJudgeRunner;
  customVerifier?: CustomVerifierRunner;
  signal?: AbortSignal;
  onAttemptCompleted?: (input: {
    completedAttempts: number;
    totalAttempts: number;
    attempt: TaskAttemptResult;
    grade: GradeResult;
  }) => Promise<void> | void;
  now?: () => string;
}): Promise<BaselineExecution> {
  const now = input.now ?? (() => new Date().toISOString());
  const evalTasks = input.tasks ?? input.taskset.tasks.filter((task) =>
    task.split === "validation" || task.split === "frozen_eval");
  if (!evalTasks.length) {
    throw new Error("Baseline requires at least one selected task.");
  }
  const work = evalTasks.flatMap((task) =>
    input.models.flatMap((model) =>
      input.seeds.flatMap((seed) =>
        Array.from({ length: input.attemptsPerTask }, (_, attempt) => ({
          task,
          model,
          seed,
          attempt,
        })))));
  let completedCount = 0;
  const completed = await mapWithConcurrency(
    work,
    Math.max(1, Math.min(8, input.concurrency ?? 1)),
    async ({ task, model, seed, attempt: attemptIndex }) => {
      throwIfAborted(input.signal);
      const attempt = {
        ...await input.runAttempt({
          tasksetId: input.taskset.id,
          task,
          model,
          seed,
          attempt: attemptIndex,
          sampling: input.sampling,
          signal: input.signal,
        }),
        tasksetId: input.taskset.id,
        taskId: task.id,
        split: task.split,
      };
      const result = await (input.gradeAttempt ?? gradeAttempt)({
        task,
        attempt,
        graders: input.taskset.graders,
        modelJudge: input.modelJudge,
        customVerifier: input.customVerifier,
        now,
      });
      completedCount += 1;
      await input.onAttemptCompleted?.({
        completedAttempts: completedCount,
        totalAttempts: work.length,
        attempt,
        grade: result,
      });
      return { attempt, grade: result };
    },
  );
  const attempts = completed.map((item) => item.attempt);
  const grades = completed.map((item) => item.grade);
  return {
    report: buildBaselineReport({
      taskset: input.taskset,
      attempts,
      grades,
      attemptsPerTask: input.attemptsPerTask,
      now,
    }),
    attempts,
    grades,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("The baseline was cancelled.");
}

export function buildBaselineReport(input: {
  taskset: Taskset;
  attempts: TaskAttemptResult[];
  grades: GradeResult[];
  attemptsPerTask: number;
  now?: () => string;
}): BaselineReport {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.attempts.length !== input.grades.length) {
    throw new Error("Baseline attempts and grades must have the same length.");
  }
  if (input.attemptsPerTask < 1) {
    throw new Error("Baseline attemptsPerTask must be at least one.");
  }
  const scored = input.grades.map((grade) => grade.score).filter((score): score is number => score !== null);
  const mean = scored.length ? scored.reduce((sum, score) => sum + score, 0) / scored.length : null;
  const variance = mean === null || scored.length === 0 ? null : scored.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scored.length;
  const failureClusters: Record<string, number> = {};
  for (const grade of input.grades) if (grade.failureClass) failureClusters[grade.failureClass] = (failureClusters[grade.failureClass] ?? 0) + 1;
  return {
    schemaVersion: "openpond.baselineReport.v1",
    id: `baseline_${contentHash(input.grades).slice(0, 24)}`,
    tasksetId: input.taskset.id,
    tasksetHash: input.taskset.contentHash,
    graderSetHash: contentHash(input.taskset.graders),
    attemptRefs: input.attempts.map((attempt) => attempt.id),
    gradeRefs: input.grades.map((grade) => grade.id),
    passAtK: passAtK(input.grades, input.attemptsPerTask),
    reward: { count: scored.length, mean, min: scored.length ? Math.min(...scored) : null, max: scored.length ? Math.max(...scored) : null, variance },
    failureClusters,
    totalCostUsd: input.attempts.every((attempt) => attempt.costUsd !== null) ? input.attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0) : null,
    userInterventions: input.attempts.reduce((sum, attempt) => sum + attempt.userInterventions, 0),
    hackingChecksPassed: input.grades.every((grade) => !grade.feedback.some((item) => item.toLowerCase().includes("reward hack"))),
    leakageChecksPassed: input.grades.every((grade) => !grade.feedback.some((item) => item.toLowerCase().includes("leak"))),
    scope: null,
    rftSignal: null,
    createdAt: now(),
  };
}

function passAtK(grades: GradeResult[], maximumK: number): Record<string, number> {
  const result: Record<string, number> = {};
  for (let k = 1; k <= maximumK; k += 1) {
    const groups = chunk(grades, maximumK);
    result[String(k)] = groups.length ? groups.filter((group) => group.slice(0, k).some((grade) => grade.passed)).length / groups.length : 0;
  }
  return result;
}
function chunk<T>(items: T[], size: number): T[][] { const output: T[][] = []; for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size)); return output; }

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await operation(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
