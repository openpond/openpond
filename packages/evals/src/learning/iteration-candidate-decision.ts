import { z } from "zod";
import { ImmutableReleaseRefSchema, ReleaseIdSchema } from "@openpond/harness";
import { LearningIterationSchema, LearningRevisionRefSchema } from "./contracts.js";
import { LearningDomainError } from "./errors.js";
import { LearningChainSchema } from "./iteration-reservation-contracts.js";
import { requireLearningResource, type LearningRepository } from "./repository.js";

export const LearningCandidateDecisionObservationSchema = z.object({
  scope: ReleaseIdSchema,
  iterationId: ReleaseIdSchema,
  decision: LearningRevisionRefSchema,
  outcome: z.enum(["accepted", "rejected"]),
  execution: ImmutableReleaseRefSchema,
  candidate: ImmutableReleaseRefSchema,
  evaluation: ImmutableReleaseRefSchema,
  receipt: ImmutableReleaseRefSchema,
}).strict();
export type LearningCandidateDecisionObservation = z.infer<typeof LearningCandidateDecisionObservationSchema>;

/** Trusted host boundary: verify the provider's immutable decision and ownership
 * before calling. This reconciles retained evidence; it does not authorize a
 * review, accept a model automatically, or activate serving. */
export async function reconcileLearningCandidateDecision(repository: LearningRepository, value: LearningCandidateDecisionObservation,
  options: { now?: () => string } = {}) {
  const input = LearningCandidateDecisionObservationSchema.parse(value);
  return repository.transaction(input.scope, async tx => {
    const iteration = await requireLearningResource(tx, "iteration", input.iterationId);
    const dispatch = await requireLearningResource(tx, "dispatch", iteration.dispatchId);
    const same = (left: { id: string; contentHash: string } | null, right: { id: string; contentHash: string }) =>
      left?.id === right.id && left.contentHash === right.contentHash;
    if (dispatch.iterationId !== iteration.id || dispatch.state !== "settled" ||
      !same(iteration.trainingJob, input.execution) || !same(dispatch.execution, input.execution) ||
      !same(iteration.candidateVersion, input.candidate) || !same(iteration.evaluationJob, input.evaluation) ||
      !same(dispatch.terminalReceipt, input.receipt)) throw new LearningDomainError("learning_candidate_decision_evidence_mismatch", 409);
    if (!["candidate_ready", "accepted", "rejected"].includes(iteration.status))
      throw new LearningDomainError("learning_candidate_not_reviewable", 409);
    const previous = iteration.candidateDecision;
    if (previous && input.decision.revision < previous.revision) return iteration;
    if (previous && input.decision.revision === previous.revision) {
      if (!same(previous, input.decision) || iteration.status !== input.outcome)
        throw new LearningDomainError("learning_candidate_decision_revision_conflict", 409);
      return iteration;
    }
    const now = (options.now ?? (() => new Date().toISOString()))();
    const updated = LearningIterationSchema.parse({ ...iteration, revision: iteration.revision + 1,
      candidateDecision: input.decision, status: input.outcome, updatedAt: now });
    await tx.put("iteration", updated, iteration.revision, { parentId: dispatch.chainId, status: updated.status });
    const chain = await requireLearningResource(tx, "chain", dispatch.chainId);
    if (chain.activeIterationId === iteration.id) await tx.put("chain", LearningChainSchema.parse({ ...chain,
      revision: chain.revision + 1, activeIterationId: null, updatedAt: now }), chain.revision, { parentId: chain.modelProjectId });
    return updated;
  });
}
