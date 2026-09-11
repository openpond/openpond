import { contentHash } from "@openpond/harness";

import { assertAdmissionDecision } from "./admission.js";
import { learningRef, sameLearningRef, type LearningPolicy, type TaskAdmissionDecision, type TaskBatch, type TaskEvidence } from "./contracts.js";
import { LearningDomainError } from "./errors.js";
import type { LearningIterationReservation } from "./iteration-reservation-contracts.js";
import { requireLearningRelease, requireLearningResource, type LearningTransaction } from "./repository.js";

export function learningChainId(modelProjectId: string): string {
  return `chain-${contentHash(modelProjectId)}`;
}

export function learningConsumptionId(chainId: string, evidence: TaskEvidence): string {
  return `consumption-${contentHash([chainId, evidence.id, evidence.revision])}`;
}

export async function inspectIterationEligibility(transaction: LearningTransaction, policy: LearningPolicy, options: { collectEligible?: boolean } = {}) {
  // These are the methods supported by the approved-batch materializer.
  const purpose: TaskBatch["purpose"] = policy.training.method === "sft" ? "supervised_training" : "reward_training";
  if (!["sft", "grpo", "ppo"].includes(policy.training.method)) {
    throw new LearningDomainError("learning_batch_method_unsupported", 422);
  }
  // Publishing a qualification reference is not proof that an automatic decision
  // was produced by a qualified executor. That admission operation is separate.
  if (policy.admission.mode !== "human") throw new LearningDomainError("learning_automatic_admission_not_available", 422);
  const definition = await requireLearningRelease(transaction, "definition", policy.taskDefinition);
  if (!sameLearningRef(definition.rewardBinding, policy.rewardBinding)) throw new LearningDomainError("learning_policy_binding_mismatch", 422);
  const counts: LearningIterationReservation["counts"] = { eligible: 0, awaitingReview: 0, excluded: 0, consumed: 0 };
  const selected: { evidence: TaskEvidence; decision: TaskAdmissionDecision }[] = [];
  const eligibleEvidence: ReturnType<typeof learningRef>[] = [];
  const chainId = learningChainId(policy.modelProjectId);
  const seen = new Set<string>();
  let backlog = 0;
  for (const sourceRef of policy.sources) {
    const source = await requireLearningRelease(transaction, "source", sourceRef);
    const currentSource = await requireLearningResource(transaction, "source", source.id);
    if (!source.enabled || !currentSource.enabled) throw new LearningDomainError("learning_source_disabled", 409);
    if (!sameLearningRef(source.taskDefinition, policy.taskDefinition)) throw new LearningDomainError("learning_policy_source_definition_mismatch", 422);
    let afterId: string | undefined;
    do {
      const page = await transaction.list("evidence", { parentId: source.id, limit: 100, ...(afterId ? { afterId } : {}) });
      for (const evidence of page.items) {
        if (seen.has(evidence.id)) continue;
        seen.add(evidence.id);
        if (!policy.sources.some((allowed) => sameLearningRef(evidence.source, allowed)) || !sameLearningRef(evidence.submission.taskDefinition, policy.taskDefinition) || evidence.submission.split !== "train") {
          counts.excluded += 1;
          continue;
        }
        if (await transaction.get("consumption", learningConsumptionId(chainId, evidence))) {
          counts.consumed += 1;
          continue;
        }
        if (++backlog > policy.limits.maxBacklogExamples) throw new LearningDomainError("learning_backlog_limit_exceeded", 409);
        const decision = await transaction.get("decision", `decision-${evidence.id}`);
        if (!decision || !sameLearningRef(decision.evidence, learningRef(evidence)) || decision.taskAdmissibility === "pending" || decision.actor.kind !== "human") {
          counts.awaitingReview += 1;
          continue;
        }
        try {
          assertAdmissionDecision({ decision, evidence, definition, purpose });
        } catch (error) {
          if (!(error instanceof LearningDomainError)) throw error;
          counts.excluded += 1;
          continue;
        }
        counts.eligible += 1;
        if (options.collectEligible) eligibleEvidence.push(learningRef(evidence));
        if (selected.length < policy.limits.maxBatchExamples) selected.push({ evidence, decision });
      }
      afterId = page.nextCursor ?? undefined;
    } while (afterId);
  }
  return { counts, selected, purpose, eligibleEvidence };
}
