import {
  EvaluationResultSchema,
  type EvaluationResult,
} from "@openpond/evals";
import { assertContentHash } from "@openpond/harness";

import { SqliteDatasetStore } from "./store-datasets.js";

export class SqliteEvaluationResultStore extends SqliteDatasetStore {
  async saveEvaluationResult(input: {
    tasksetId: string;
    kind: "baseline" | "candidate";
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
