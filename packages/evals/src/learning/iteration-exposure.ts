import { contentHash } from "@openpond/harness";
import { sameLearningRef, type TaskBatch } from "./contracts.js";
import { LearningDomainError } from "./errors.js";
import { LearningConsumptionSchema } from "./iteration-reservation-contracts.js";
import type { LearningIterationObservation } from "./iteration-dispatch-contracts.js";
import type { LearningTransaction } from "./repository.js";

/** Called only in fenced terminal settlement. Absence/timeout is never evidence
 * of zero exposure; unresolved rows keep their original reservation. */
export async function settleLearningIterationExposure(tx: LearningTransaction, input: {
  chainId: string; iterationId: string; batch: TaskBatch;
  outcome: LearningIterationObservation | null; unstarted: boolean;
}) {
  const coverage = input.outcome?.coverage;
  if (!input.unstarted && !coverage) return;
  if (coverage && (coverage.length !== input.batch.examples.length ||
      new Set(coverage.map(entry => contentHash(entry.evidence))).size !== coverage.length ||
      coverage.some(entry => !input.batch.examples.some(example => sameLearningRef(example.evidence, entry.evidence)))))
    throw new LearningDomainError("learning_execution_coverage_mismatch", 409);
  for (const example of input.batch.examples) {
    const id = `consumption-${contentHash([input.chainId, example.evidence.id, example.evidence.revision])}`;
    const current = await tx.get("consumption", id);
    if (!current || current.iterationId !== input.iterationId || !sameLearningRef(current.evidence, example.evidence))
      throw new LearningDomainError("learning_execution_consumption_mismatch", 409);
    const exposure = input.unstarted ? "unexposed" : coverage!.find(entry => sameLearningRef(entry.evidence, example.evidence))!.outcome;
    if (exposure === "unknown") continue;
    // A terminal replay cannot downgrade already proven numerical exposure.
    if (["trained", "exposed"].includes(current.exposure ?? "") && exposure !== current.exposure)
      throw new LearningDomainError("learning_execution_coverage_conflict", 409);
    const next = LearningConsumptionSchema.parse({ ...current, revision: current.revision + 1,
      exposure, executionReceipt: input.outcome?.receipt ?? null });
    await tx.put("consumption", next, current.revision, { parentId: input.chainId });
  }
}
