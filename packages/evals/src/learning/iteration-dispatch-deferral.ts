import { LearningIterationSchema, type LearningIteration } from "./contracts.js";
import { LearningDomainError } from "./errors.js";
import { LearningIterationDispatchSchema, LearningIterationSubmissionDeferralSchema,
  type LearningIterationDispatch } from "./iteration-dispatch-contracts.js";
import type { LearningTransaction } from "./repository.js";

/** Call under the dispatch's scope lock. The execution owner must first fence
 * this attempt and prove no execution/charge exists. When the owner shares this
 * repository, commit this mutation in its native admission transaction instead:
 * late submits then fail the same generation fence as lease replacement.
 */
export async function deferLearningIterationSubmission(tx: LearningTransaction, scope: string,
  current: LearningIterationDispatch, iteration: LearningIteration, value: unknown, now: string) {
  const outcome = LearningIterationSubmissionDeferralSchema.parse(value);
  if (outcome.scope !== scope || outcome.dispatchId !== current.id || outcome.submissionHash !== current.submissionHash ||
    outcome.leaseGeneration !== current.leaseGeneration || !current.submissionStartedAt || current.execution ||
    current.state !== "prepared" || !current.leaseOwner ||
    !current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= Date.parse(now) ||
    iteration.id !== current.iterationId || (iteration.status !== "dispatching" && !(current.cancelRequestedAt && iteration.status === "cancelling")))
    throw new LearningDomainError("learning_submission_deferral_fenced", 409);
  const retryAt = new Date(Math.max(Date.parse(outcome.retryAt), Date.parse(now) + 1_000)).toISOString();
  const dispatch = LearningIterationDispatchSchema.parse({ ...current, revision: current.revision + 1,
    submissionStartedAt: null, leaseGeneration: current.leaseGeneration + 1, leaseOwner: null, leaseExpiresAt: null,
    admission: current.cancelRequestedAt ? null : { status: "deferred", reason: outcome.reason, retryAt },
    nextAttemptAt: current.cancelRequestedAt ? null : retryAt, lastSubmissionDeferral: outcome,
    consecutiveFailures: 0, lastError: null, updatedAt: now });
  await tx.put("dispatch", dispatch, current.revision, { parentId: current.iterationId, status: dispatch.state });
  if (iteration.failure) await tx.put("iteration", LearningIterationSchema.parse({ ...iteration,
    revision: iteration.revision + 1, failure: null, updatedAt: now }), iteration.revision,
    { parentId: current.chainId, status: iteration.status });
  return dispatch;
}
