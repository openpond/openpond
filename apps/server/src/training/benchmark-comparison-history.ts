import { compareBenchmarkRuns, type BenchmarkRunSummary } from "@openpond/evals";
import { contentHash } from "@openpond/harness";
import type { Taskset } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";

/** Compare only matching immutable protocols; another model, reasoning effort
 * or release in the same Taskset history is not a comparison counterpart. */
export async function persistBenchmarkComparison(input: {
  store: Pick<SqliteStore, "listBenchmarkRuns" | "saveBenchmarkComparison">;
  tasksetId: string;
  benchmark: NonNullable<Taskset["benchmark"]>;
  run: BenchmarkRunSummary;
  createdAt: string;
}) {
  const { run } = input;
  const history = await input.store.listBenchmarkRuns(input.tasksetId);
  const counterpart = (phase: "baseline" | "candidate") => run.phase === phase ? run : history.find(candidate =>
    candidate.phase === phase
    && candidate.tasksetRelease.contentHash === run.tasksetRelease.contentHash
    && candidate.model.provider === run.model.provider
    && candidate.model.model === run.model.model
    && candidate.reasoningEffort === run.reasoningEffort
    && contentHash(candidate.protocol) === contentHash(run.protocol));
  const baseline = counterpart("baseline");
  const candidate = counterpart("candidate");
  if (!baseline || !candidate) return null;
  const comparison = compareBenchmarkRuns({
    id: `benchmark-comparison-${contentHash([baseline.contentHash, candidate.contentHash]).slice(0, 24)}`,
    baseline,
    candidate,
    primaryMetric: input.benchmark.primaryMetric,
    qualityGate: input.benchmark.qualityGate,
    createdAt: input.createdAt,
    metadata: { sourceTasksetId: input.tasksetId, benchmarkDefinitionId: input.benchmark.definitionId },
  });
  await input.store.saveBenchmarkComparison({ tasksetId: input.tasksetId, comparison });
  return comparison;
}
