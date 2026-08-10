import {
  BenchmarkComparisonSchema,
  BenchmarkRunSummarySchema,
  EvaluationResultSchema,
  type BenchmarkComparison,
  type BenchmarkRunSummary,
  type EvaluationResult,
} from "@openpond/evals";
import { assertContentHash } from "@openpond/harness";

import { SqliteDatasetStore } from "./store-datasets.js";

export class SqliteEvaluationResultStore extends SqliteDatasetStore {
  async saveBenchmarkRun(input: {
    tasksetId: string;
    run: BenchmarkRunSummary;
  }): Promise<BenchmarkRunSummary> {
    const run = BenchmarkRunSummarySchema.parse(input.run);
    assertContentHash(run, "Benchmark run");
    await this.upsertPayload(
      `INSERT INTO benchmark_runs (id, taskset_id, phase, payload, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [run.id, input.tasksetId, run.phase, JSON.stringify(run), run.createdAt],
    );
    return run;
  }

  async listBenchmarkRuns(tasksetId: string): Promise<BenchmarkRunSummary[]> {
    return this.listParsedPayloads(
      "SELECT payload FROM benchmark_runs WHERE taskset_id = ? ORDER BY created_at DESC, id ASC",
      [tasksetId],
      BenchmarkRunSummarySchema.parse,
    );
  }

  async saveBenchmarkComparison(input: {
    tasksetId: string;
    comparison: BenchmarkComparison;
  }): Promise<BenchmarkComparison> {
    const comparison = BenchmarkComparisonSchema.parse(input.comparison);
    assertContentHash(comparison, "Benchmark comparison");
    await this.upsertPayload(
      `INSERT INTO benchmark_comparisons (id, taskset_id, payload, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [comparison.id, input.tasksetId, JSON.stringify(comparison), comparison.createdAt],
    );
    return comparison;
  }

  async listBenchmarkComparisons(tasksetId: string): Promise<BenchmarkComparison[]> {
    return this.listParsedPayloads(
      "SELECT payload FROM benchmark_comparisons WHERE taskset_id = ? ORDER BY created_at DESC, id ASC",
      [tasksetId],
      BenchmarkComparisonSchema.parse,
    );
  }

  async saveEvaluationResult(input: {
    tasksetId: string;
    kind: "baseline" | "adaptation" | "candidate";
    result: EvaluationResult;
    createdAt: string;
  }): Promise<EvaluationResult> {
    const result = EvaluationResultSchema.parse(input.result);
    assertContentHash(result, "Evaluation result");
    if (result.metadata.sourceTasksetId !== input.tasksetId) {
      throw new Error("Evaluation result does not match the supplied Taskset identity.");
    }
    const existing = await this.getEvaluationResult(result.id);
    if (existing) {
      if (existing.contentHash !== result.contentHash) {
        throw new Error(`Evaluation result ${result.id} is immutable and already has another content hash.`);
      }
      return existing;
    }
    await this.upsertPayload(
      `INSERT INTO evaluation_results (id, taskset_id, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [result.id, input.tasksetId, input.kind, JSON.stringify(result), input.createdAt],
    );
    return result;
  }

  async getEvaluationResult(id: string): Promise<EvaluationResult | null> {
    return this.getParsedPayload(
      "SELECT payload FROM evaluation_results WHERE id = ?",
      [id],
      EvaluationResultSchema.parse,
    );
  }

  async listEvaluationResults(
    tasksetId: string,
    kind?: "baseline" | "candidate",
  ): Promise<EvaluationResult[]> {
    return this.listParsedPayloads(
      kind
        ? "SELECT payload FROM evaluation_results WHERE taskset_id = ? AND kind = ? ORDER BY created_at DESC, id ASC"
        : "SELECT payload FROM evaluation_results WHERE taskset_id = ? ORDER BY created_at DESC, id ASC",
      kind ? [tasksetId, kind] : [tasksetId],
      EvaluationResultSchema.parse,
    );
  }
}
