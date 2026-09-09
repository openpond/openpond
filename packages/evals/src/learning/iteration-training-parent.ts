import type { z } from "zod";

import { LearningAcceptedParentSchema, sameLearningRef, type LearningPolicy } from "./contracts.js";
import { LearningDomainError } from "./errors.js";
import { requireLearningRelease, requireLearningResource, type LearningTransaction } from "./repository.js";

type AcceptedParent = z.infer<typeof LearningAcceptedParentSchema>;

/** Select the latest accepted human decision. A later rejection removes that
 * candidate from future selection without rewriting reserved descendants. */
export async function latestAcceptedLearningParent(tx: LearningTransaction, chainId: string, requireComplete = false): Promise<AcceptedParent | null> {
  let selected: AcceptedParent | null = null;
  let afterId: string | undefined;
  do {
    const page = await tx.list("iteration", { parentId: chainId, status: "accepted", limit: 100, ...(afterId ? { afterId } : {}) });
    for (const iteration of page.items) {
      if (!iteration.candidateVersion || !iteration.candidateDecision || !iteration.candidateDecisionAt || !iteration.trainingJob) {
        if (requireComplete) throw new LearningDomainError("learning_accepted_parent_evidence_missing", 409);
        continue;
      }
      const candidate = LearningAcceptedParentSchema.parse({ iterationId: iteration.id, iterationRevision: iteration.revision,
        candidate: iteration.candidateVersion, decision: iteration.candidateDecision, decidedAt: iteration.candidateDecisionAt });
      const order = [Date.parse(candidate.decidedAt), candidate.decision.id, candidate.decision.revision] as const;
      const previous = selected ? [Date.parse(selected.decidedAt), selected.decision.id, selected.decision.revision] as const : null;
      if (!previous || order[0] > previous[0] || (order[0] === previous[0]
        && (order[1] > previous[1] || (order[1] === previous[1] && order[2] > previous[2])))) selected = candidate;
    }
    afterId = page.nextCursor ?? undefined;
  } while (afterId);
  return selected;
}

/** Reservation captures an accepted revision before dispatch or later reviews.
 * Switching the underlying base requires a separately reviewed learning chain. */
export async function resolveLearningTrainingParent(tx: LearningTransaction, policy: LearningPolicy, selection: AcceptedParent | null) {
  if (!selection) return { trainingParent: policy.trainingParent, trainingParentSelection: null };
  const parent = await requireLearningResource(tx, "iteration", selection.iterationId, selection.iterationRevision);
  const sourcePolicy = await requireLearningRelease(tx, "policy", parent.policy);
  if (parent.status !== "accepted" || !parent.candidateVersion || !parent.candidateDecision || !parent.trainingJob
    || parent.candidateVersion.id !== selection.candidate.id || parent.candidateVersion.contentHash !== selection.candidate.contentHash
    || !sameLearningRef(parent.candidateDecision, selection.decision) || parent.candidateDecisionAt !== selection.decidedAt
    || sourcePolicy.modelProjectId !== policy.modelProjectId || sourcePolicy.executionOwner !== policy.executionOwner) {
    throw new LearningDomainError("learning_accepted_parent_evidence_mismatch", 409);
  }
  if (sourcePolicy.trainingParent.id !== policy.trainingParent.id || sourcePolicy.trainingParent.contentHash !== policy.trainingParent.contentHash
    || sourcePolicy.training.method !== policy.training.method) {
    throw new LearningDomainError("learning_accepted_parent_configuration_mismatch", 409,
      "The accepted checkpoint belongs to a different starting model or training method.");
  }
  return { trainingParent: selection.candidate, trainingParentSelection: selection };
}
