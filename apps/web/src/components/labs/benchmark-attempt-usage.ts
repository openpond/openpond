import type { ModelEvaluationReceipt } from "@openpond/contracts";

type BenchmarkAttempt = ModelEvaluationReceipt["attempts"][number];
type BenchmarkPhase = BenchmarkAttempt["phase"];

export type BenchmarkForegroundUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
};

export type BenchmarkTaskEfficiencyPair = {
  cohort: "adaptation" | "held_out";
  taskId: string;
  baseline: BenchmarkAttempt;
  refined: BenchmarkAttempt;
  tokenDelta: number;
};

export type BenchmarkTaskEfficiencySummary = {
  pairs: BenchmarkTaskEfficiencyPair[];
  comparedTaskCount: number;
  lowerTaskCount: number;
  higherTaskCount: number;
  unchangedTaskCount: number;
  baselineTokens: number;
  refinedTokens: number;
  tokenDelta: number;
  tokenDeltaPercent: number | null;
  baselinePassedCount: number;
  refinedPassedCount: number;
  cohorts: Record<"adaptation" | "held_out", {
    comparedTaskCount: number;
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
  const pairs = ([
    ["adaptation", "adaptation", "candidate_adaptation"],
    ["held_out", "baseline", "candidate"],
  ] as const).flatMap(([cohort, baselinePhase, refinedPhase]) => {
    const refinedByTask = new Map(
      selected
        .filter((attempt) => attempt.phase === refinedPhase)
        .map((attempt) => [attempt.taskId, attempt]),
    );
    return selected
      .filter((attempt) => attempt.phase === baselinePhase)
      .flatMap((baseline) => {
        const refined = refinedByTask.get(baseline.taskId);
        return refined ? [{
          cohort,
          taskId: baseline.taskId,
          baseline,
          refined,
          tokenDelta: refined.totalTokens - baseline.totalTokens,
        }] : [];
      });
  });
  const baselineTokens = pairs.reduce(
    (sum, pair) => sum + pair.baseline.totalTokens,
    0,
  );
  const refinedTokens = pairs.reduce(
    (sum, pair) => sum + pair.refined.totalTokens,
    0,
  );
  const tokenDelta = refinedTokens - baselineTokens;
  const summarizePairs = (items: BenchmarkTaskEfficiencyPair[]) => ({
    comparedTaskCount: items.length,
    lowerTaskCount: items.filter((pair) => pair.tokenDelta < 0).length,
    higherTaskCount: items.filter((pair) => pair.tokenDelta > 0).length,
    unchangedTaskCount: items.filter((pair) => pair.tokenDelta === 0).length,
  });

  return {
    pairs,
    ...summarizePairs(pairs),
    baselineTokens,
    refinedTokens,
    tokenDelta,
    tokenDeltaPercent: baselineTokens > 0
      ? (tokenDelta / baselineTokens) * 100
      : null,
    baselinePassedCount: pairs.filter((pair) => pair.baseline.passed).length,
    refinedPassedCount: pairs.filter((pair) => pair.refined.passed).length,
    cohorts: {
      adaptation: summarizePairs(
        pairs.filter((pair) => pair.cohort === "adaptation"),
      ),
      held_out: summarizePairs(
        pairs.filter((pair) => pair.cohort === "held_out"),
      ),
    },
  };
}
