import type { Taskset } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";

import type { NativeModelToolResult } from "../openpond/native-tool-calls.js";

export type HarnessRefinerBenchmarkStage =
  | "baseline"
  | "adaptation"
  | "candidate_adaptation"
  | "candidate";

export type HarnessRefinerExecutionPlanItem = {
  stage: HarnessRefinerBenchmarkStage;
  split: string;
  taskIds: string[];
  attemptCount: number;
};

export function createHarnessRefinerExecutionPlan(input: {
  taskset: Taskset;
  seeds: number[];
  repetitions: number;
}): HarnessRefinerExecutionPlanItem[] {
  const benchmark = input.taskset.benchmark;
  if (!benchmark) throw new Error("Harness Refiner Taskset has no benchmark definition.");
  const heldOut = taskIdsForSplit(input.taskset, benchmark.evaluationSplit);
  const adaptation = taskIdsForSplit(input.taskset, benchmark.adaptationSplit);
  const multiplier = input.seeds.length * input.repetitions;
  return [
    planItem("baseline", benchmark.evaluationSplit, heldOut, multiplier),
    planItem("adaptation", benchmark.adaptationSplit, adaptation, multiplier),
    planItem("candidate_adaptation", benchmark.adaptationSplit, adaptation, multiplier),
    planItem("candidate", benchmark.evaluationSplit, heldOut, multiplier),
  ];
}

export function totalPlannedAttempts(plan: HarnessRefinerExecutionPlanItem[]): number {
  return plan.reduce((total, item) => total + item.attemptCount, 0);
}

export function totalPlannedTasks(plan: HarnessRefinerExecutionPlanItem[]): number {
  return new Set(plan.flatMap((item) => item.taskIds)).size;
}

export function completedBeforeStage(
  plan: HarnessRefinerExecutionPlanItem[],
  stage: HarnessRefinerBenchmarkStage,
): number {
  const index = plan.findIndex((item) => item.stage === stage);
  if (index < 0) throw new Error(`Benchmark execution plan has no ${stage} stage.`);
  return plan.slice(0, index).reduce((total, item) => total + item.attemptCount, 0);
}

export class BenchmarkSpendBudget {
  readonly maximumSpendUsd: number;
  #observedSpendUsd: number;

  constructor(maximumSpendUsd: number, observedSpendUsd = 0) {
    if (!Number.isFinite(maximumSpendUsd) || maximumSpendUsd <= 0) {
      throw new Error("Benchmark maximum spend must be a positive finite number.");
    }
    if (!Number.isFinite(observedSpendUsd) || observedSpendUsd < 0) {
      throw new Error("Observed benchmark spend must be a non-negative finite number.");
    }
    this.maximumSpendUsd = maximumSpendUsd;
    this.#observedSpendUsd = observedSpendUsd;
  }

  get observedSpendUsd(): number {
    return this.#observedSpendUsd;
  }

  assertAvailable(label: string): void {
    if (this.#observedSpendUsd >= this.maximumSpendUsd) {
      throw new Error(
        `Benchmark maximum spend of $${this.maximumSpendUsd.toFixed(2)} was reached before ${label}.`,
      );
    }
  }

  charge(costUsd: number | null | undefined, label: string): void {
    if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
      throw new Error(`Benchmark cost for ${label} is unavailable; the spend ceiling cannot be enforced.`);
    }
    const next = this.#observedSpendUsd + costUsd;
    if (next > this.maximumSpendUsd + 1e-9) {
      throw new Error(
        `Benchmark maximum spend of $${this.maximumSpendUsd.toFixed(2)} was exceeded during ${label}.`,
      );
    }
    this.#observedSpendUsd = next;
  }
}

export type FrozenToolObservation = {
  cohort: "adaptation" | "held_out";
  taskId: string;
  toolName: "web_search" | "web_fetch";
  argumentsHash: string;
  ordinal: number;
  result: NativeModelToolResult;
};

export type BenchmarkEvidenceSnapshotManifest = {
  schemaVersion: "openpond.benchmarkEvidenceSnapshot.v1";
  id: string;
  observations: FrozenToolObservation[];
  contentHash: string;
};

export class FrozenToolEvidenceExhaustedError extends Error {
  constructor(
    readonly taskId: string,
    readonly toolName: "web_search" | "web_fetch",
    readonly ordinal: number,
  ) {
    super(
      `Frozen web evidence is unavailable for ${taskId} ${toolName} call ${ordinal + 1}.`,
    );
    this.name = "FrozenToolEvidenceExhaustedError";
  }
}

export class BenchmarkEvidenceSnapshot {
  #observations = new Map<string, FrozenToolObservation>();
  #callCounts = new Map<string, number>();

  constructor(observations: readonly FrozenToolObservation[] = []) {
    for (const observation of observations) {
      const key = observationKey(observation);
      if (this.#observations.has(key)) {
        throw new Error(`Frozen web evidence contains duplicate observation ${key}.`);
      }
      this.#observations.set(key, structuredClone(observation));
    }
  }

  async execute(input: {
    mode: "record" | "replay";
    cohort: "adaptation" | "held_out";
    taskId: string;
    toolName: string;
    args: Record<string, unknown>;
    execute: () => Promise<NativeModelToolResult>;
  }): Promise<NativeModelToolResult> {
    if (input.toolName !== "web_search" && input.toolName !== "web_fetch") {
      return input.execute();
    }
    const argumentsHash = contentHash(input.args);
    const sequenceKey = `${input.mode}:${input.cohort}:${input.taskId}:${input.toolName}`;
    const ordinal = this.#callCounts.get(sequenceKey) ?? 0;
    this.#callCounts.set(sequenceKey, ordinal + 1);
    const key = observationKey({
      cohort: input.cohort,
      taskId: input.taskId,
      toolName: input.toolName,
      ordinal,
    });
    if (input.mode === "replay") {
      const observation = this.#observations.get(key);
      if (!observation) {
        throw new FrozenToolEvidenceExhaustedError(
          input.taskId,
          input.toolName,
          ordinal,
        );
      }
      // Replay is deliberately keyed by the admitted task/tool ordinal instead
      // of the model-authored argument bytes. A refined Harness can phrase the
      // same search differently, and exact argument matching would turn harmless
      // wording drift into an infrastructure failure. The immutable observation
      // still records the baseline argument hash for auditability, while both
      // sides receive the exact same frozen external result at each call site.
      return structuredClone(observation.result);
    }
    const result = await input.execute();
    const observation: FrozenToolObservation = {
      cohort: input.cohort,
      taskId: input.taskId,
      toolName: input.toolName,
      argumentsHash,
      ordinal,
      result: structuredClone(result),
    };
    this.#observations.set(key, observation);
    return result;
  }

  manifest(): BenchmarkEvidenceSnapshotManifest {
    const observations = [...this.#observations.values()].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
    const core = {
      schemaVersion: "openpond.benchmarkEvidenceSnapshot.v1" as const,
      id: `benchmark-evidence-${contentHash(observations).slice(0, 24)}`,
      observations,
    };
    return { ...core, contentHash: contentHash(core) };
  }
}

function observationKey(input: Pick<
  FrozenToolObservation,
  "cohort" | "taskId" | "toolName" | "ordinal"
>): string {
  return `${input.cohort}:${input.taskId}:${input.toolName}:${input.ordinal}`;
}

export function benchmarkEfficiency(input: {
  baselineTokens: number;
  candidateTokens: number;
  refinerTokens: number;
  graderTokens: number;
  amortizedReuseCount?: number;
}) {
  const grossForegroundTokenSavings = input.baselineTokens - input.candidateTokens;
  const overheadTokens = input.refinerTokens + input.graderTokens;
  const firstPassNetTokenSavings = grossForegroundTokenSavings - overheadTokens;
  const breakEvenReuseCount = grossForegroundTokenSavings > 0
    ? Math.ceil(overheadTokens / grossForegroundTokenSavings)
    : null;
  const amortizedReuseCount = input.amortizedReuseCount ?? 10;
  return {
    grossForegroundTokenSavings,
    overheadTokens,
    firstPassNetTokenSavings,
    breakEvenReuseCount,
    amortizedTokenSavings:
      grossForegroundTokenSavings * amortizedReuseCount - overheadTokens,
    amortizedReuseCount,
  };
}

export function benchmarkAttemptsInfrastructureValid(
  attempts: Array<{
    grade: { score: number | null; failureClass: string | null };
  }>,
): boolean {
  const infrastructureFailures = new Set([
    "grader_failure",
    "environment_failure",
    "infrastructure_failure",
    "timeout",
    "cancelled",
  ]);
  return attempts.every((attempt) =>
    typeof attempt.grade.score === "number"
    && !infrastructureFailures.has(attempt.grade.failureClass ?? "")
  );
}

function taskIdsForSplit(taskset: Taskset, split: string): string[] {
  const taskIds = taskset.tasks
    .filter((task) => task.split === split)
    .map((task) => task.id);
  if (!taskIds.length) throw new Error(`Harness Refiner split ${split} has no cases.`);
  return taskIds;
}

function planItem(
  stage: HarnessRefinerBenchmarkStage,
  split: string,
  taskIds: string[],
  multiplier: number,
): HarnessRefinerExecutionPlanItem {
  return { stage, split, taskIds, attemptCount: taskIds.length * multiplier };
}
