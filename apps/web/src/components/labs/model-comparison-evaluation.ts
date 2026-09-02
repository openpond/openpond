import type {
  ModelComparisonBenchmarkReceipt,
  ModelRun,
} from "@openpond/contracts";

export function comparisonReceipt(
  run: ModelRun,
): ModelComparisonBenchmarkReceipt | null {
  return run.receipt?.schemaVersion === "openpond.modelComparisonBenchmarkReceipt.v1"
    ? run.receipt
    : null;
}

export function comparisonRunScore(run: ModelRun): number | null {
  return comparisonReceipt(run)?.deterministic.passRate ?? null;
}
