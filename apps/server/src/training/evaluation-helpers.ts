import {
  TaskAttemptResultSchema,
  type DatasetSelectionStrategy,
  type DatasetSplit,
  type GradeResult,
  type TaskAttemptResult,
  type TaskDataRecord,
  type Taskset,
  type TasksetBaselineRun,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import { extractFinalAnswer } from "./exact-answer.js";

const REQUIRED_MIXED_RFT_GROUPS = 4;

type AuditFixture = {
  id: string;
  taskId: string;
  label: string;
  output: Record<string, unknown>;
  infrastructureError: string | null;
  metadata?: Record<string, unknown>;
};

export function fixtureAttempt(tasksetId: string, fixture: AuditFixture, index: number) {
  const timestamp = new Date().toISOString();
  return TaskAttemptResultSchema.parse({
    schemaVersion: "openpond.taskAttempt.v1",
    id: `fixture_attempt_${fixture.id}_${index}`,
    tasksetId,
    taskId: fixture.taskId,
    split: artifactSplit(fixture) ?? "frozen_eval",
    attempt: index,
    seed: 0,
    modelRef: null,
    startedAt: timestamp,
    completedAt: timestamp,
    output: fixture.output,
    runtimeEventRefs: [],
    artifactRefs: [],
    privilegedOutcomeRef: null,
    infrastructureError: fixture.infrastructureError,
    costUsd: 0,
    latencyMs: 0,
    userInterventions: 0,
    metadata: { fixtureLabel: fixture.label },
  });
}

export function artifactSplit(fixture: {
  taskId?: string;
  metadata?: Record<string, unknown>;
}): DatasetSplit | null {
  const value = fixture.metadata?.artifactSplit;
  return value === "train"
      || value === "validation"
      || value === "test"
      || value === "frozen_eval"
    ? value
    : null;
}

export function inlineBaselineTasks(input: {
  taskset: Taskset;
  split: "train" | "validation" | "frozen_eval";
  limit: number;
  seed: number;
  selectionStrategy: DatasetSelectionStrategy;
}): { tasks: TaskDataRecord[]; taskIdsHash: string } {
  if (input.selectionStrategy !== "stable_hash_top_n") {
    throw new Error("The easy RFT curriculum is available for artifact-backed Datasets.");
  }
  const tasks = input.taskset.tasks
    .filter((task) => task.split === input.split)
    .sort((left, right) =>
      contentHash([
        input.taskset.contentHash,
        input.seed,
        input.split,
        left.id,
      ]).localeCompare(contentHash([
        input.taskset.contentHash,
        input.seed,
        input.split,
        right.id,
      ]))
      || left.id.localeCompare(right.id))
    .slice(0, input.limit);
  return {
    tasks,
    taskIdsHash: contentHash(tasks.map((task) => task.id)),
  };
}

export function summarizeRftSignal(attempts: TaskAttemptResult[], grades: GradeResult[]) {
  const gradeByAttempt = new Map(grades.map((grade) => [grade.attemptId, grade]));
  const groups = new Map<string, GradeResult[]>();
  let infrastructureFailures = 0;
  let eligibleAttempts = 0;
  let correctAttempts = 0;
  let incorrectAttempts = 0;
  let parseableAttempts = 0;
  for (const attempt of attempts) {
    const grade = gradeByAttempt.get(attempt.id);
    if (!grade) continue;
    const group = groups.get(attempt.taskId) ?? [];
    group.push(grade);
    groups.set(attempt.taskId, group);
    if (attempt.infrastructureError || grade.failureClass === "infrastructure_failure") {
      infrastructureFailures += 1;
    }
    if (grade.score !== null) {
      eligibleAttempts += 1;
      if (grade.passed) correctAttempts += 1;
      else incorrectAttempts += 1;
    }
    const text = typeof attempt.output.text === "string" ? attempt.output.text : "";
    if (extractFinalAnswer(text) !== null) parseableAttempts += 1;
  }
  let mixedRewardGroups = 0;
  let allCorrectRewardGroups = 0;
  let allIncorrectRewardGroups = 0;
  let unscoredGroups = 0;
  for (const gradesForTask of groups.values()) {
    const eligible = gradesForTask.filter((grade) => grade.score !== null);
    const correct = eligible.filter((grade) => grade.passed).length;
    const incorrect = eligible.length - correct;
    if (correct > 0 && incorrect > 0) mixedRewardGroups += 1;
    else if (correct > 0) allCorrectRewardGroups += 1;
    else if (incorrect > 0) allIncorrectRewardGroups += 1;
    else unscoredGroups += 1;
  }
  return {
    requiredMixedRewardGroups: REQUIRED_MIXED_RFT_GROUPS,
    mixedRewardGroups,
    allCorrectRewardGroups,
    allIncorrectRewardGroups,
    unscoredGroups,
    infrastructureFailures,
    eligibleAttempts,
    correctAttempts,
    incorrectAttempts,
    parseableAttempts,
    passed: mixedRewardGroups >= REQUIRED_MIXED_RFT_GROUPS && infrastructureFailures === 0,
  };
}

export function auditFlags(attempts: TaskAttemptResult[], grades: GradeResult[]) {
  const infraAttempts = attempts.filter((attempt) => attempt.infrastructureError);
  const infrastructureSafe = infraAttempts.every((attempt) => {
    const grade = grades.find((item) => item.attemptId === attempt.id);
    return grade?.score === null && grade.rewardEligible === false;
  });
  const suspicious = grades.some((grade) =>
    grade.feedback.some((item) => /reward hack|prompt injection/i.test(item))
    && (grade.score ?? 0) >= 0.8
  );
  const leakage = grades.some((grade) =>
    grade.feedback.some((item) => /privileged.*leak|hidden grader.*leak/i.test(item))
  );
  return {
    hackingChecksPassed: infrastructureSafe && !suspicious,
    leakageChecksPassed: !leakage,
  };
}

export function isActiveBaselineRun(status: TasksetBaselineRun["status"]): boolean {
  return status === "queued"
    || status === "preparing"
    || status === "running"
    || status === "cancelling";
}
