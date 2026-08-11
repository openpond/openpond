import type { Taskset } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";

import {
  attemptToolFailureCount,
  attemptUsageSummary,
  benchmarkToolFailureEvidence,
  taskPrompt,
  type BenchmarkAttemptEvidence,
} from "./harness-refiner-benchmark-service-support.js";

const MAX_REQUEST_CHARACTERS = 2_500;
const MAX_OUTPUT_CHARACTERS = 4_000;
const BEHAVIOR_FAMILY_TAGS = [
  "artifact-verification",
  "research-efficiency",
  "constraint-following",
] as const;

type CohortToolFailure = {
  toolName: string;
  turn: number | null;
  detail: string;
  recoveredLater: boolean;
};

export type HarnessRefinerBenchmarkCohortAttempt = {
  attemptId: string;
  taskId: string;
  behaviorFamily: string;
  attemptReceiptHash: string;
  gradeHash: string;
  passed: boolean;
  score: number | null;
  failureClass: string | null;
  feedback: string[];
  request: string;
  requestTruncated: boolean;
  assistantOutput: string;
  assistantOutputTruncated: boolean;
  evaluationCriteria: Record<string, unknown> | null;
  artifactResults: Array<{
    path: string;
    mediaType: string;
    passed: boolean;
    validationKinds: string[];
  }>;
  outputsPassed: boolean | null;
  toolFailureCount: number;
  toolFailures: CohortToolFailure[];
  omittedToolFailureCount: number;
  latencyMs: number;
  usage: ReturnType<typeof attemptUsageSummary>;
};

export type HarnessRefinerBenchmarkCohortEvidence = {
  schemaVersion: "openpond.harnessRefinerBenchmarkCohortEvidence.v2";
  reviewScope: "adaptation_cohort";
  recurrencePolicy: {
    minimumDistinctAdaptationTasks: 2;
    primaryTurnIsAnchorOnly: true;
  };
  attemptCount: number;
  passedCount: number;
  scoredAttemptCount: number;
  tasksWithToolFailures: number;
  totalToolFailureCount: number;
  totalLatencyMs: number;
  totalTokens: number;
  behaviorFamilies: Array<{
    behaviorFamily: string;
    attemptCount: number;
    passedCount: number;
    failedTaskIds: string[];
    taskIds: string[];
    toolFailureCount: number;
    tasksWithToolFailures: number;
  }>;
  crossTaskToolFailureGroups: Array<{
    toolName: string;
    distinctTaskCount: number;
    occurrenceCount: number;
    taskIds: string[];
  }>;
  primaryEvidenceAnchor: {
    attemptId: string;
    taskId: string;
    reason: "repeated_cross_task_tool_failure" | "failed_grade" | "highest_signal_attempt";
  };
  attempts: HarnessRefinerBenchmarkCohortAttempt[];
};

function boundedText(value: unknown, limit: number): {
  text: string;
  truncated: boolean;
} {
  const text = typeof value === "string" ? value : "";
  return {
    text: text.slice(0, limit),
    truncated: text.length > limit,
  };
}

function taskBehaviorFamily(task: Taskset["tasks"][number]): string {
  const families = BEHAVIOR_FAMILY_TAGS.filter((tag) => task.tags.includes(tag));
  if (families.length !== 1) {
    throw new Error(`Adaptation task ${task.id} has no behavior-family contract.`);
  }
  return families[0]!;
}

function artifactResults(
  output: BenchmarkAttemptEvidence["attempt"]["output"],
): HarnessRefinerBenchmarkCohortAttempt["artifactResults"] {
  const requiredOutputs = Array.isArray(output.requiredOutputs)
    ? output.requiredOutputs
    : [];
  return requiredOutputs.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (
      typeof item.path !== "string"
      || typeof item.mediaType !== "string"
      || typeof item.passed !== "boolean"
    ) return [];
    return [{
      path: item.path,
      mediaType: item.mediaType,
      passed: item.passed,
      validationKinds: Array.isArray(item.validationKinds)
        ? item.validationKinds.filter((kind): kind is string => typeof kind === "string")
        : [],
    }];
  });
}

function repeatedToolFailureGroups(
  attempts: HarnessRefinerBenchmarkCohortAttempt[],
): HarnessRefinerBenchmarkCohortEvidence["crossTaskToolFailureGroups"] {
  const groups = new Map<string, { occurrences: number; taskIds: Set<string> }>();
  for (const attempt of attempts) {
    for (const failure of attempt.toolFailures) {
      const group = groups.get(failure.toolName) ?? {
        occurrences: 0,
        taskIds: new Set<string>(),
      };
      group.occurrences += 1;
      group.taskIds.add(attempt.taskId);
      groups.set(failure.toolName, group);
    }
  }
  return [...groups.entries()]
    .map(([toolName, group]) => ({
      toolName,
      distinctTaskCount: group.taskIds.size,
      occurrenceCount: group.occurrences,
      taskIds: [...group.taskIds],
    }))
    .filter((group) => group.distinctTaskCount >= 2)
    .sort((left, right) =>
      right.distinctTaskCount - left.distinctTaskCount
      || right.occurrenceCount - left.occurrenceCount
      || left.toolName.localeCompare(right.toolName)
    );
}

function selectPrimaryEvidenceAnchor(
  attempts: HarnessRefinerBenchmarkCohortAttempt[],
  repeatedGroups: HarnessRefinerBenchmarkCohortEvidence["crossTaskToolFailureGroups"],
): HarnessRefinerBenchmarkCohortEvidence["primaryEvidenceAnchor"] {
  const repeatedTool = repeatedGroups[0]?.toolName;
  if (repeatedTool) {
    const ranked = attempts
      .map((attempt, index) => ({
        attempt,
        index,
        matchingFailures: attempt.toolFailures.filter(
          (failure) => failure.toolName === repeatedTool,
        ).length,
      }))
      .filter((item) => item.matchingFailures > 0)
      .sort((left, right) =>
        right.matchingFailures - left.matchingFailures
        || left.attempt.toolFailureCount - right.attempt.toolFailureCount
        || left.index - right.index
      );
    const selected = ranked[0]?.attempt;
    if (selected) {
      return {
        attemptId: selected.attemptId,
        taskId: selected.taskId,
        reason: "repeated_cross_task_tool_failure",
      };
    }
  }
  const failed = attempts.find((attempt) => !attempt.passed);
  if (failed) {
    return {
      attemptId: failed.attemptId,
      taskId: failed.taskId,
      reason: "failed_grade",
    };
  }
  const selected = [...attempts].sort((left, right) =>
    right.toolFailureCount - left.toolFailureCount
    || right.latencyMs - left.latencyMs
  )[0];
  if (!selected) throw new Error("Adaptation cohort produced no Refiner evidence.");
  return {
    attemptId: selected.attemptId,
    taskId: selected.taskId,
    reason: "highest_signal_attempt",
  };
}

export async function buildHarnessRefinerBenchmarkCohortEvidence(input: {
  taskset: Taskset;
  adaptationAttempts: BenchmarkAttemptEvidence[];
}): Promise<HarnessRefinerBenchmarkCohortEvidence> {
  const attempts = await Promise.all(input.adaptationAttempts.map(async (result) => {
    const task = input.taskset.tasks.find(
      (candidate) => candidate.id === result.attempt.taskId,
    );
    if (!task || task.split !== "validation") {
      throw new Error(`Adaptation evidence task ${result.attempt.taskId} is unavailable.`);
    }
    const toolFailureCount = attemptToolFailureCount(result);
    const toolFailureEvidence = await benchmarkToolFailureEvidence({
      attemptId: result.attempt.id,
      artifacts: result.artifacts,
      expectedCount: toolFailureCount,
    });
    const request = boundedText(taskPrompt(task), MAX_REQUEST_CHARACTERS);
    const assistantOutput = boundedText(
      result.attempt.output.text,
      MAX_OUTPUT_CHARACTERS,
    );
    return {
      attemptId: result.attempt.id,
      taskId: result.attempt.taskId,
      behaviorFamily: taskBehaviorFamily(task),
      attemptReceiptHash: result.receiptContentHash,
      gradeHash: contentHash(result.grade),
      passed: result.grade.passed,
      score: result.grade.score,
      failureClass: result.grade.failureClass,
      feedback: [...result.grade.feedback],
      request: request.text,
      requestTruncated: request.truncated,
      assistantOutput: assistantOutput.text,
      assistantOutputTruncated: assistantOutput.truncated,
      evaluationCriteria: task.expectedOutput,
      artifactResults: artifactResults(result.attempt.output),
      outputsPassed: typeof result.attempt.output.outputsPassed === "boolean"
        ? result.attempt.output.outputsPassed
        : null,
      toolFailureCount,
      toolFailures: toolFailureEvidence.failures,
      omittedToolFailureCount: toolFailureEvidence.omittedCount,
      latencyMs: result.attempt.latencyMs,
      usage: attemptUsageSummary(result.attempt.metadata.usage),
    } satisfies HarnessRefinerBenchmarkCohortAttempt;
  }));
  const families = new Map<string, HarnessRefinerBenchmarkCohortAttempt[]>();
  for (const attempt of attempts) {
    const family = families.get(attempt.behaviorFamily) ?? [];
    family.push(attempt);
    families.set(attempt.behaviorFamily, family);
  }
  const behaviorFamilies = [...families.entries()]
    .map(([behaviorFamily, familyAttempts]) => ({
      behaviorFamily,
      attemptCount: familyAttempts.length,
      passedCount: familyAttempts.filter((attempt) => attempt.passed).length,
      failedTaskIds: familyAttempts
        .filter((attempt) => !attempt.passed)
        .map((attempt) => attempt.taskId),
      taskIds: familyAttempts.map((attempt) => attempt.taskId),
      toolFailureCount: familyAttempts.reduce(
        (total, attempt) => total + attempt.toolFailureCount,
        0,
      ),
      tasksWithToolFailures: familyAttempts.filter(
        (attempt) => attempt.toolFailureCount > 0,
      ).length,
    }))
    .sort((left, right) => left.behaviorFamily.localeCompare(right.behaviorFamily));
  const crossTaskToolFailureGroups = repeatedToolFailureGroups(attempts);
  return {
    schemaVersion: "openpond.harnessRefinerBenchmarkCohortEvidence.v2",
    reviewScope: "adaptation_cohort",
    recurrencePolicy: {
      minimumDistinctAdaptationTasks: 2,
      primaryTurnIsAnchorOnly: true,
    },
    attemptCount: attempts.length,
    passedCount: attempts.filter((attempt) => attempt.passed).length,
    scoredAttemptCount: attempts.filter(
      (attempt) => typeof attempt.score === "number",
    ).length,
    tasksWithToolFailures: attempts.filter(
      (attempt) => attempt.toolFailureCount > 0,
    ).length,
    totalToolFailureCount: attempts.reduce(
      (total, attempt) => total + attempt.toolFailureCount,
      0,
    ),
    totalLatencyMs: attempts.reduce(
      (total, attempt) => total + attempt.latencyMs,
      0,
    ),
    totalTokens: attempts.reduce(
      (total, attempt) => total + attempt.usage.totalTokens,
      0,
    ),
    behaviorFamilies,
    crossTaskToolFailureGroups,
    primaryEvidenceAnchor: selectPrimaryEvidenceAnchor(
      attempts,
      crossTaskToolFailureGroups,
    ),
    attempts,
  };
}
