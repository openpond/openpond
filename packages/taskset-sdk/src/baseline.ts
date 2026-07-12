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
}) => Promise<TaskAttemptResult>;

export type BaselineExecution = {
  report: BaselineReport;
  attempts: TaskAttemptResult[];
  grades: GradeResult[];
};

export async function runBaseline(input: {
  taskset: Taskset;
  models: ChatModelRef[];
  seeds: number[];
  attemptsPerTask: number;
  runAttempt: BaselineAttemptRunner;
  modelJudge?: ModelJudgeRunner;
  customVerifier?: CustomVerifierRunner;
  now?: () => string;
}): Promise<BaselineExecution> {
  const now = input.now ?? (() => new Date().toISOString());
  const attempts: TaskAttemptResult[] = [];
  const grades: GradeResult[] = [];
  const evalTasks = input.taskset.tasks.filter((task) => task.split === "validation" || task.split === "frozen_eval");
  for (const task of evalTasks) {
    for (const model of input.models) {
      for (const seed of input.seeds) {
        for (let attemptIndex = 0; attemptIndex < input.attemptsPerTask; attemptIndex += 1) {
          const attempt = {
            ...await input.runAttempt({ tasksetId: input.taskset.id, task, model, seed, attempt: attemptIndex }),
            tasksetId: input.taskset.id,
            taskId: task.id,
            split: task.split,
          };
          attempts.push(attempt);
          grades.push(await gradeAttempt({ task, attempt, graders: input.taskset.graders, modelJudge: input.modelJudge, customVerifier: input.customVerifier, now }));
        }
      }
    }
  }
  const scored = grades.map((grade) => grade.score).filter((score): score is number => score !== null);
  const mean = scored.length ? scored.reduce((sum, score) => sum + score, 0) / scored.length : null;
  const variance = mean === null || scored.length === 0 ? null : scored.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scored.length;
  const failureClusters: Record<string, number> = {};
  for (const grade of grades) if (grade.failureClass) failureClusters[grade.failureClass] = (failureClusters[grade.failureClass] ?? 0) + 1;
  const report: BaselineReport = {
    schemaVersion: "openpond.baselineReport.v1",
    id: `baseline_${contentHash(grades).slice(0, 24)}`,
    tasksetId: input.taskset.id,
    tasksetHash: input.taskset.contentHash,
    graderSetHash: contentHash(input.taskset.graders),
    attemptRefs: attempts.map((attempt) => attempt.id),
    gradeRefs: grades.map((grade) => grade.id),
    passAtK: passAtK(grades, input.attemptsPerTask),
    reward: { count: scored.length, mean, min: scored.length ? Math.min(...scored) : null, max: scored.length ? Math.max(...scored) : null, variance },
    failureClusters,
    totalCostUsd: attempts.every((attempt) => attempt.costUsd !== null) ? attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0) : null,
    userInterventions: attempts.reduce((sum, attempt) => sum + attempt.userInterventions, 0),
    hackingChecksPassed: grades.every((grade) => !grade.feedback.some((item) => item.toLowerCase().includes("reward hack"))),
    leakageChecksPassed: grades.every((grade) => !grade.feedback.some((item) => item.toLowerCase().includes("leak"))),
    createdAt: now(),
  };
  return { report, attempts, grades };
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
