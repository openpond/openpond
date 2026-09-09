import { contentHash } from "@openpond/harness";
import { LearningIterationSchema, type LearningIteration, type LearningPolicy, type TaskBatch } from "./contracts.js";
import { LearningDomainError } from "./errors.js";
import { LearningChainSchema, LearningIterationReservationSchema } from "./iteration-reservation-contracts.js";
import {
  LearningIterationDispatchSchema, LearningIterationObservationSchema, LearningIterationSubmissionSchema,
  type LearningIterationDispatch, type LearningIterationObservation, type LearningIterationSubmission,
} from "./iteration-dispatch-contracts.js";
import { requireLearningRelease, requireLearningResource, type LearningRepository, type LearningTransaction } from "./repository.js";

export type LearningIterationExecutionContext = {
  scope: string;
  dispatch: LearningIterationDispatch;
  iteration: LearningIteration;
  policy: LearningPolicy;
  batch: TaskBatch;
  signal: AbortSignal;
};
export interface LearningIterationExecutor {
  /** Resolve immutable inputs and validate compatibility. Must not launch compute. */
  prepare(input: LearningIterationExecutionContext): Promise<LearningIterationSubmission>;
  /** Return the existing execution under dispatch.id; null means not found.
   * An unavailable owner must throw, never report absence. */
  reconcile(input: LearningIterationExecutionContext): Promise<LearningIterationObservation | null>;
  /** Idempotently submit exactly dispatch.submission under dispatch.id, across
   * crashes, lease owners and retries. Never create a different Job on retry. */
  submit(input: LearningIterationExecutionContext): Promise<LearningIterationObservation>;
  /** Cancel by dispatch identity, including an ambiguous initial submission.
   * Terminal confirmation MUST fence late submits under that identity, including
   * when no Job was created. A network abort alone is not cleanup confirmation. */
  cancel(input: LearningIterationExecutionContext): Promise<LearningIterationObservation>;
}

const closed = new Set(["accepted", "rejected", "failed", "cancelled", "completed_without_candidate"]);

export function createLearningIterationWorker(repository: LearningRepository, executor: LearningIterationExecutor, options: {
  workerId: string;
  executionOwner: LearningPolicy["executionOwner"];
  now?: () => string;
  leaseMs?: number;
  requestTimeoutMs?: number;
}) {
  const now = options.now ?? (() => new Date().toISOString());
  const leaseMs = options.leaseMs ?? 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 45_000;
  if (!Number.isFinite(leaseMs) || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1 || leaseMs <= requestTimeoutMs) throw new Error("Iteration lease must exceed its bounded request timeout.");

  async function claim(scope: string, id: string) {
    return repository.transaction(scope, async tx => {
      const iteration = await requireLearningResource(tx, "iteration", id);
      if (closed.has(iteration.status) || iteration.status === "candidate_ready" || !iteration.batch) return null;
      const current = await tx.get("dispatch", iteration.dispatchId);
      const stamp = now();
      if (current?.state === "settled" || (current?.state === "blocked" && !current.cancelRequestedAt)
        || (current?.leaseExpiresAt && Date.parse(current.leaseExpiresAt) > Date.parse(stamp))
        || (current?.nextAttemptAt && Date.parse(current.nextAttemptAt) > Date.parse(stamp))) return null;
      const policy = await requireLearningRelease(tx, "policy", iteration.policy);
      if (policy.executionOwner !== options.executionOwner) throw new LearningDomainError("learning_execution_owner_mismatch", 409);
      const latestPolicy = await requireLearningResource(tx, "policy", policy.id);
      if (!latestPolicy.enabled && !current?.submissionStartedAt && !current?.cancelRequestedAt) return null;
      const batch = await requireLearningRelease(tx, "batch", iteration.batch);
      const reservation = await requireLearningResource(tx, "reservation", id);
      const chain = await requireLearningResource(tx, "chain", reservation.chainId);
      if (chain.activeIterationId !== id || reservation.outcome !== "reserved") throw new LearningDomainError("learning_dispatch_reservation_mismatch", 409);
      const dispatch = LearningIterationDispatchSchema.parse({
        schemaVersion: "openpond.learningIterationDispatch.v1", id: iteration.dispatchId,
        iterationId: id, chainId: chain.id, policy: iteration.policy, batch: iteration.batch,
        state: "preparing", submission: null, submissionHash: null, submissionStartedAt: null,
        execution: null, terminalReceipt: null, cancelRequestedAt: null,
        consecutiveFailures: 0, nextAttemptAt: null, lastError: null, createdAt: stamp,
        ...current, revision: (current?.revision ?? 0) + 1,
        leaseOwner: options.workerId, leaseGeneration: (current?.leaseGeneration ?? 0) + 1,
        leaseExpiresAt: new Date(Date.parse(stamp) + leaseMs).toISOString(), updatedAt: stamp,
      });
      if (dispatch.iterationId !== id || contentHash(dispatch.policy) !== contentHash(iteration.policy) || contentHash(dispatch.batch) !== contentHash(iteration.batch)) throw new LearningDomainError("learning_dispatch_identity_mismatch", 409);
      await tx.put("dispatch", dispatch, current?.revision ?? 0, { parentId: id, status: dispatch.state });
      const running = LearningIterationSchema.parse({ ...iteration, revision: iteration.revision + 1,
        status: iteration.status === "cancelling" ? "cancelling" : current?.submissionStartedAt ? iteration.status : "dispatching", updatedAt: stamp });
      await tx.put("iteration", running, iteration.revision, { parentId: chain.id, status: running.status });
      return { dispatch, iteration: running, policy, batch };
    });
  }

  async function fenced<T>(scope: string, claimed: LearningIterationDispatch, update: (tx: LearningTransaction, current: LearningIterationDispatch, iteration: LearningIteration) => Promise<T>): Promise<T | null> {
    return repository.transaction(scope, async tx => {
      const current = await requireLearningResource(tx, "dispatch", claimed.id);
      if (current.leaseOwner !== options.workerId || current.leaseGeneration !== claimed.leaseGeneration
        || !current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= Date.parse(now()) || current.state === "settled") return null;
      return update(tx, current, await requireLearningResource(tx, "iteration", current.iterationId));
    });
  }

  async function saveDispatch(tx: LearningTransaction, current: LearningIterationDispatch, patch: Partial<LearningIterationDispatch>) {
    const updated = LearningIterationDispatchSchema.parse({ ...current, ...patch, revision: current.revision + 1, updatedAt: now() });
    await tx.put("dispatch", updated, current.revision, { parentId: current.iterationId, status: updated.state });
    return updated;
  }

  async function settle(tx: LearningTransaction, current: LearningIterationDispatch, iteration: LearningIteration, outcome: LearningIterationObservation | null) {
    const terminal = !outcome || ["succeeded", "failed", "cancelled"].includes(outcome.status);
    const status = !outcome ? "cancelled" : outcome.status === "succeeded"
      ? outcome.candidate ? "candidate_ready" : "completed_without_candidate"
      : outcome.status === "running" ? current.cancelRequestedAt ? "cancelling" : "training"
      : outcome.status === "evaluating" ? current.cancelRequestedAt ? "cancelling" : "evaluating" : outcome.status;
    const updated = LearningIterationSchema.parse({
      ...iteration, revision: iteration.revision + 1, status, updatedAt: now(),
      trainingJob: outcome?.execution ?? iteration.trainingJob, evaluationJob: outcome?.evaluation ?? iteration.evaluationJob,
      candidateVersion: outcome?.candidate ?? iteration.candidateVersion, spendUsd: outcome?.spendUsd ?? iteration.spendUsd,
      failure: outcome?.failure ? { code: "learning_execution_failed", message: outcome.failure } : null,
    });
    await tx.put("iteration", updated, iteration.revision, { parentId: current.chainId, status });
    await saveDispatch(tx, current, { state: terminal ? "settled" : "submitted", execution: outcome?.execution ?? current.execution,
      terminalReceipt: outcome?.receipt ?? null, leaseOwner: null, leaseExpiresAt: null,
      nextAttemptAt: terminal ? null : new Date(Date.parse(now()) + 5_000).toISOString(), consecutiveFailures: 0, lastError: null });
    if (terminal) {
      const reservation = await requireLearningResource(tx, "reservation", iteration.id);
      const settled = LearningIterationReservationSchema.parse({ ...reservation, revision: reservation.revision + 1,
        budget: { ...reservation.budget, reservedSpendUsd: 0, settledSpendUsd: updated.spendUsd, settledAt: now() }, updatedAt: now() });
      await tx.put("reservation", settled, reservation.revision, { parentId: current.chainId, status: settled.outcome });
      if (status !== "candidate_ready") {
        const chain = await requireLearningResource(tx, "chain", current.chainId);
        if (chain.activeIterationId === iteration.id) await tx.put("chain", LearningChainSchema.parse({ ...chain, revision: chain.revision + 1, activeIterationId: null, updatedAt: now() }), chain.revision, { parentId: chain.modelProjectId });
      }
    }
    return updated;
  }

  async function run(scope: string, iterationId: string): Promise<LearningIteration> {
    const acquired = await claim(scope, iterationId);
    const read = () => repository.transaction(scope, tx => requireLearningResource(tx, "iteration", iterationId));
    if (!acquired) return read();
    let dispatch = acquired.dispatch;
    const bounded = async <T>(operation: (input: LearningIterationExecutionContext) => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { const error = new Error("Learning dispatch request timed out; reconcile its existing identity."); controller.abort(error); reject(error); }, requestTimeoutMs); });
      try { return await Promise.race([operation({ ...structuredClone({ scope, ...acquired, dispatch }), signal: controller.signal }), timeout]); }
      finally { clearTimeout(timer!); }
    };
    try {
      if (dispatch.cancelRequestedAt && !dispatch.submissionStartedAt) {
        await fenced(scope, dispatch, (tx, current, iteration) => settle(tx, current, iteration, null));
        return read();
      }
      if (!dispatch.submission) {
        const submission = LearningIterationSubmissionSchema.parse(await bounded(input => executor.prepare(input)));
        const prepared = await fenced(scope, dispatch, (tx, current) => saveDispatch(tx, current, { submission, submissionHash: contentHash(submission), state: "prepared" }));
        if (!prepared) return read();
        dispatch = prepared;
      }
      const starting = await fenced(scope, dispatch, async (tx, current, iteration) => {
        if (current.cancelRequestedAt && !current.submissionStartedAt) { await settle(tx, current, iteration, null); return null; }
        const policy = await requireLearningResource(tx, "policy", current.policy.id);
        if (!policy.enabled && !current.submissionStartedAt) { await saveDispatch(tx, current, { leaseOwner: null, leaseExpiresAt: null }); return null; }
        return saveDispatch(tx, current, { submissionStartedAt: current.submissionStartedAt ?? now() });
      });
      if (!starting) return read();
      dispatch = starting;
      let observed = dispatch.cancelRequestedAt ? await bounded(input => executor.cancel(input)) : await bounded(input => executor.reconcile(input));
      if (!observed) {
        const refreshed = await fenced(scope, dispatch, (tx, current) => saveDispatch(tx, current, {}));
        if (!refreshed) return read();
        dispatch = refreshed;
        observed = dispatch.cancelRequestedAt ? await bounded(input => executor.cancel(input)) : await bounded(input => executor.submit(input));
      }
      const outcome = LearningIterationObservationSchema.parse(observed);
      if (outcome.scope !== scope || outcome.dispatchId !== dispatch.id || outcome.submissionHash !== dispatch.submissionHash
        || (dispatch.execution && contentHash(outcome.execution) !== contentHash(dispatch.execution))) throw new LearningDomainError("learning_execution_identity_mismatch", 409);
      await fenced(scope, dispatch, async (tx, current, iteration) => {
        if (outcome.submissionHash !== current.submissionHash || (current.execution && contentHash(outcome.execution) !== contentHash(current.execution))) throw new LearningDomainError("learning_execution_identity_mismatch", 409);
        if (outcome.spendUsd < iteration.spendUsd) throw new LearningDomainError("learning_execution_spend_regressed", 409);
        return settle(tx, current, iteration, outcome);
      });
    } catch (error) {
      await fenced(scope, dispatch, async (tx, current, iteration) => {
        const failures = current.consecutiveFailures + 1;
        const blocked = failures > acquired.policy.limits.maxRetries;
        const message = (error instanceof Error ? error.message : "Learning dispatch failed.").slice(0, 20_000);
        await saveDispatch(tx, current, { state: blocked ? "blocked" : current.state, consecutiveFailures: failures,
          lastError: message, leaseOwner: null, leaseExpiresAt: null,
          nextAttemptAt: blocked ? null : new Date(Date.parse(now()) + Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6))).toISOString() });
        const updated = LearningIterationSchema.parse({ ...iteration, revision: iteration.revision + 1, retryCount: iteration.retryCount + 1,
          failure: { code: blocked ? "learning_dispatch_attention_required" : "learning_dispatch_retry_pending", message }, updatedAt: now() });
        await tx.put("iteration", updated, iteration.revision, { parentId: current.chainId, status: updated.status });
      });
    }
    return read();
  }
  return { run };
}
