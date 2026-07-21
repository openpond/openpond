import type { RolloutTrajectoryReceipt } from "@openpond/contracts";
import {
  crossSystemAnswersEqual,
  verifyCrossSystemTrajectory,
} from "./cross-system-operations/index.js";

export function rftTrainingReward(input: {
  task: Parameters<typeof verifyCrossSystemTrajectory>[0]["task"];
  trajectory: Parameters<typeof verifyCrossSystemTrajectory>[0]["trajectory"];
  verifier: ReturnType<typeof verifyCrossSystemTrajectory>;
}): RolloutTrajectoryReceipt["reward"] {
  if (!input.verifier.rewardEligible) {
    return {
      eligible: false,
      raw: null,
      normalized: null,
      components: {
        semanticAnswer: 0,
        responseContract: 0,
        requiredToolEvidence: 0,
      },
    };
  }
  const final = [...input.trajectory.steps]
    .reverse()
    .find((step) => step.kind === "final");
  const bareAnswer = final ? bareJsonObject(final.content) : null;
  const candidateAnswer = input.verifier.parsedAnswer ?? bareAnswer;
  const semanticProgress = candidateAnswer == null
    ? 0
    : answerProgress(candidateAnswer, input.task.expectedAnswer);
  const requiredTools = new Set(input.task.queryPlan.map((item) => item.tool));
  const successfulRequiredTools = new Set(
    input.trajectory.steps.flatMap((step) =>
      step.kind === "tool_result"
      && step.ok
      && requiredTools.has(step.name)
        ? [step.name]
        : []),
  );
  const requiredToolEvidence = requiredTools.size
    ? roundReward((successfulRequiredTools.size / requiredTools.size) * 0.15)
    : 0.15;
  const responseContract = input.verifier.parsedAnswer != null ? 0.25 : 0;
  const semanticAnswer = roundReward(semanticProgress * 0.6);
  const reward = roundReward(
    Math.min(1, semanticAnswer + responseContract + requiredToolEvidence),
  );
  return {
    eligible: true,
    raw: reward,
    normalized: reward,
    components: {
      semanticAnswer,
      responseContract,
      requiredToolEvidence,
    },
  };
}

function answerProgress(actual: unknown, expected: unknown): number {
  if (crossSystemAnswersEqual(actual, expected)) return 1;
  return structuredSimilarity(actual, expected);
}

function structuredSimilarity(actual: unknown, expected: unknown): number {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return 0;
    if (!expected.length) return actual.length ? 0 : 1;
    const expectedCounts = valueCounts(expected);
    const actualCounts = valueCounts(actual);
    let overlap = 0;
    for (const [value, count] of expectedCounts) {
      overlap += Math.min(count, actualCounts.get(value) ?? 0);
    }
    if (!overlap) return 0;
    const precision = overlap / Math.max(1, actual.length);
    const recall = overlap / expected.length;
    return (2 * precision * recall) / (precision + recall);
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return 0;
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const expectedKeys = Object.keys(expectedRecord);
    if (!expectedKeys.length) return Object.keys(actualRecord).length ? 0 : 1;
    const fieldScore = expectedKeys.reduce(
      (sum, key) => sum + structuredSimilarity(actualRecord[key], expectedRecord[key]),
      0,
    ) / expectedKeys.length;
    const extraKeys = Object.keys(actualRecord).filter(
      (key) => !Object.hasOwn(expectedRecord, key),
    ).length;
    return fieldScore * (expectedKeys.length / (expectedKeys.length + extraKeys));
  }
  if (typeof expected === "string" && typeof actual === "string") {
    return actual.normalize("NFC").trim() === expected.normalize("NFC").trim() ? 1 : 0;
  }
  return Object.is(actual, expected) ? 1 : 0;
}

function valueCounts(values: unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = stableJson(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return typeof value === "string" ? value.normalize("NFC").trim() : value;
}

function bareJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value.trim()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function roundReward(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
