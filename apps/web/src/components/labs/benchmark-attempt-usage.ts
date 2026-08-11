import {
  summarizeModelEvaluationTaskEfficiency,
  type ModelEvaluationReceipt,
  type ModelEvaluationTaskEfficiency,
  type ModelEvaluationTaskEfficiencyPair,
} from "@openpond/contracts";

type BenchmarkAttempt = ModelEvaluationReceipt["attempts"][number];
type BenchmarkPhase = BenchmarkAttempt["phase"];

export type BenchmarkForegroundUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
};

export type BenchmarkTaskEfficiencyPair = ModelEvaluationTaskEfficiencyPair;

export type BenchmarkTaskEfficiencySummary = Omit<
  ModelEvaluationTaskEfficiency,
  "cohorts"
> & {
  pairs: BenchmarkTaskEfficiencyPair[];
  baselinePassedCount: number;
  refinedPassedCount: number;
  cohorts: Record<"adaptation" | "held_out", {
    targetTaskCount: number;
    comparedTaskCount: number;
    passedTaskCount: number;
    failedTaskCount: number;
    lowerTaskCount: number;
    higherTaskCount: number;
    unchangedTaskCount: number;
  }>;
};

export function benchmarkResultAccepted(receipt: ModelEvaluationReceipt): boolean {
  return receipt.terminalClassification === "improved"
    && receipt.quality.passed
    && receipt.lineage.valid
    && receipt.invalidReasons.length === 0;
}

const BENCHMARK_PHASES = [
  "baseline",
  "adaptation",
  "candidate_adaptation",
  "candidate",
] as const satisfies readonly BenchmarkPhase[];

export function benchmarkSelectedAttempts(
  attempts: ModelEvaluationReceipt["attempts"],
): BenchmarkAttempt[] {
  const selected = new Map<string, BenchmarkAttempt>();
  for (const attempt of attempts) {
    const key = `${attempt.phase}\u0000${attempt.taskId}`;
    const current = selected.get(key);
    if (
      !current
      || attempt.startedAt > current.startedAt
      || (
        attempt.startedAt === current.startedAt
        && attempt.attemptId > current.attemptId
      )
    ) {
      selected.set(key, attempt);
    }
  }
  return [...selected.values()];
}

/**
 * Summarize the canonical one-attempt-per-task benchmark result. Accounting
 * retains discarded infrastructure attempts so observed spend remains auditable;
 * the comparison itself selects the latest durable attempt for each task.
 */
export function benchmarkForegroundUsage(
  receipt: ModelEvaluationReceipt,
): Record<BenchmarkPhase, BenchmarkForegroundUsage> {
  const selected = benchmarkSelectedAttempts(receipt.attempts);
  return Object.fromEntries(BENCHMARK_PHASES.map((phase) => {
    const attempts = selected.filter((attempt) => attempt.phase === phase);
    const costs = attempts
      .map((attempt) => attempt.costUsd)
      .filter((cost): cost is number => cost !== null);
    return [phase, {
      inputTokens: attempts.reduce((sum, attempt) => sum + attempt.inputTokens, 0),
      outputTokens: attempts.reduce((sum, attempt) => sum + attempt.outputTokens, 0),
      totalTokens: attempts.reduce((sum, attempt) => sum + attempt.totalTokens, 0),
      costUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null,
    }];
  })) as Record<BenchmarkPhase, BenchmarkForegroundUsage>;
}

/** Pair the canonical baseline/refined attempt for every task in both cohorts. */
export function benchmarkTaskEfficiency(
  receipt: ModelEvaluationReceipt,
): BenchmarkTaskEfficiencySummary {
  const selected = benchmarkSelectedAttempts(receipt.attempts ?? []);
  const { summary, pairs } = summarizeModelEvaluationTaskEfficiency({
    attempts: selected,
  });

  return {
    ...summary,
    pairs,
    baselinePassedCount: pairs.filter((pair) => pair.baseline.passed).length,
    refinedPassedCount: pairs.filter((pair) => pair.refined.passed).length,
    cohorts: {
      adaptation: summary.cohorts.adaptation,
      held_out: summary.cohorts.heldOut,
    },
  };
}
