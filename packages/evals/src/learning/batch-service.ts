import { resolveBoundRewards } from "../rewards.js";
import { compileTaskBatch, sealTaskBatch, taskFamilyReservations, type TaskFamilySplit } from "./admission.js";
import { learningRef, sameLearningRef, type LearningRevisionRef, type TaskEvidence } from "./contracts.js";
import { LearningDomainError } from "./errors.js";
import type { LearningCommand } from "./operations.js";
import { requireLearningRelease, requireLearningResource, type LearningResourceKind, type LearningResourcePointer, type LearningTransaction } from "./repository.js";

export async function sealLearningBatch(transaction: LearningTransaction, input: Extract<LearningCommand, { action: "seal_batch" }>, actorId: string, timestamp: string): Promise<LearningResourcePointer[]> {
  const { batch, release, evidence, definition } = await prepareLearningBatch(transaction, input, actorId, timestamp);
  for (const item of evidence) {
    for (const reservation of taskFamilyReservations(item, definition)) await transaction.reserveFamilySplit(reservation.namespace, reservation.kind, reservation.key, reservation.split);
  }
  await transaction.put("batch", batch, 0, { parentId: definition.id });
  await transaction.put("package", release, 0, { parentId: batch.id });
  return [pointer("batch", batch), pointer("package", release)];
}

/** Performs the complete shared validation without reserving families or publishing resources. */
export async function prepareLearningBatch(transaction: LearningTransaction, input: Extract<LearningCommand, { action: "seal_batch" }>, actorId: string, timestamp: string) {
  const definition = await requireLearningRelease(transaction, "definition", input.taskDefinition);
  const binding = await requireLearningRelease(transaction, "binding", definition.rewardBinding);
  const rewards = await Promise.all(binding.sources.map((source) => requireLearningRelease(transaction, "reward", source.reward)));
  resolveBoundRewards(binding, rewards);
  const evidence = await Promise.all(input.evidence.map((ref) => requireCurrentLearningEvidence(transaction, ref)));
  const decisions = await Promise.all(input.decisions.map(async (ref) => {
    const decision = await requireLearningRelease(transaction, "decision", ref);
    const current = await requireLearningResource(transaction, "decision", ref.id);
    if (!sameLearningRef(learningRef(current), ref)) throw new LearningDomainError("task_admission_revision_stale", 409);
    return decision;
  }));
  const priorSplits: TaskFamilySplit[] = [];
  for (const item of evidence) {
    for (const reservation of taskFamilyReservations(item, definition)) {
      const split = await transaction.familySplit(reservation.namespace, reservation.kind, reservation.key);
      if (split !== null) priorSplits.push({ ...reservation, split: split as TaskFamilySplit["split"] });
    }
  }
  const batch = sealTaskBatch({ id: input.batchId, definition, binding, rewards, purpose: input.purpose, evidence, decisions, priorSplits, actorId, now: timestamp });
  const release = compileTaskBatch({ batch, definition, binding, rewards, evidence, decisions });
  return { batch, release, evidence, definition };
}

export async function requireCurrentLearningEvidence(transaction: LearningTransaction, ref: LearningRevisionRef): Promise<TaskEvidence> {
  const evidence = await requireLearningRelease(transaction, "evidence", ref);
  const current = await requireLearningResource(transaction, "evidence", ref.id);
  if (!sameLearningRef(learningRef(current), ref)) throw new LearningDomainError("task_evidence_revision_stale", 409);
  return evidence;
}

function pointer(kind: LearningResourceKind, resource: { id: string; revision: number }): LearningResourcePointer { return { kind, id: resource.id, revision: resource.revision }; }
