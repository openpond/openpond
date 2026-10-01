import { contentHash } from "@openpond/harness";
import { HumanReviewSchema, type HumanReview } from "./contracts.js";
import { LearningDomainError } from "../learning/errors.js";
/** Call only after current host authority/evidence checks. Acceptance grants no learning use or adoption. */
export function acceptedHumanEvidence(raw: HumanReview, expected: { reviewHash: string; decisionHash: string }) {
  const review = HumanReviewSchema.parse(raw);
  const { contentHash: hash, ...content } = review;
  const decision = review.decisions.at(-1);
  if (hash !== contentHash(content) || hash !== expected.reviewHash || review.status !== "accepted" || !decision || decision.outcome !== "accept" || decision.contentHash !== expected.decisionHash) throw new LearningDomainError("human_accepted_revision_unavailable", 409);
  const submissions = decision.submissions.map(ref => {
    const submission = review.submissions.find(s => s.id === ref.id && s.contentHash === ref.contentHash);
    if (!submission || submission.evidenceHash !== contentHash(review.evidence) || submission.formHash !== contentHash(review.form)) throw new LearningDomainError("human_accepted_lineage_invalid", 409);
    return { id: submission.id, revision: submission.revision, contentHash: submission.contentHash };
  });
  return { schemaVersion: "openpond.acceptedHumanEvidence.v1" as const, scope: review.scope, projectId: review.projectId, review: { id: review.id, revision: review.revision, contentHash: hash }, sourceOrigins:review.evidence.attempts.map(attempt=>attempt.localSource?attempt.localSource.kind:attempt.recordedSource?"recorded_evidence" as const:"hosted_retained" as const),decision: { id: decision.id, revision: decision.revision, contentHash: decision.contentHash }, submissions, evidence: review.evidence, answers: decision.answers, ...(review.execution?.result?{execution:{id:review.execution.executionId!,result:review.execution.result,configurationHash:review.execution.configurationHash}}:{}), ...(decision.taskProposalHash?{taskProposal:review.submissions.find(s=>s.taskProposal?.contentHash===decision.taskProposalHash)!.taskProposal}:{}) };
}
