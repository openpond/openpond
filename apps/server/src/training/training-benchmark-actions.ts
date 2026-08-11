import {
  ChatModelRefSchema,
  CodexReasoningEffortSchema,
} from "@openpond/contracts";

import type { createTaskEvaluationService } from "./evaluation-service.js";
import type { createHarnessRefinerBenchmarkService } from "./harness-refiner-benchmark-service.js";
import {
  harnessIntegerArray,
  nonnegativeHarnessNumber,
} from "./harness-training-api-inputs.js";

type Evaluation = ReturnType<typeof createTaskEvaluationService>;
type HarnessRefinerBenchmarks = ReturnType<
  typeof createHarnessRefinerBenchmarkService
>;

export function runTasksetBenchmark(
  evaluation: Evaluation,
  input: Record<string, unknown>,
) {
  return evaluation.executeBenchmark({
    tasksetId: requiredString(input.tasksetId, "tasksetId"),
    phase: input.phase === "candidate" ? "candidate" : "baseline",
    model: ChatModelRefSchema.parse(input.model),
    reasoningEffort: reasoningEffort(input.reasoningEffort),
    seeds: harnessIntegerArray(input.seeds, "seeds"),
    repetitions: boundedInteger(input.repetitions, "repetitions", 1, 20, 1),
    sampling: { maxOutputTokens: 4_096, temperature: 0, topP: 1 },
  });
}

export function startHarnessRefinerBenchmark(
  service: HarnessRefinerBenchmarks | undefined,
  input: Record<string, unknown>,
) {
  if (!service) {
    throw new Error("Harness Refiner benchmark execution is not configured.");
  }
  return service.start({
    modelId: requiredString(input.modelId, "modelId"),
    profileId: requiredString(input.profileId, "profileId"),
    model: ChatModelRefSchema.parse(input.model),
    reasoningEffort: reasoningEffort(input.reasoningEffort),
    seeds: [17],
    repetitions: 1,
    maximumSpendUsd: positiveHarnessNumber(input.maximumSpendUsd ?? 10),
  });
}

function positiveHarnessNumber(value: unknown): number {
  const parsed = nonnegativeHarnessNumber(value, "maximumSpendUsd");
  if (parsed === 0) {
    throw new Error("maximumSpendUsd must be greater than zero.");
  }
  return parsed;
}

function reasoningEffort(value: unknown) {
  return value === null || value === "none"
    ? value
    : CodexReasoningEffortSchema.parse(value ?? "high");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
