import { contentHash } from "@openpond/harness";

import { sealLearningBatch } from "./batch-service.js";
import { LearningIterationSchema, learningRef, sameLearningRef } from "./contracts.js";
import { LearningDomainError } from "./errors.js";
import { inspectIterationEligibility, learningChainId, learningConsumptionId } from "./iteration-eligibility.js";
import { LearningChainSchema, LearningConsumptionSchema, LearningIterationReservationSchema } from "./iteration-reservation-contracts.js";
import type { LearningCommand } from "./operations.js";
import { requireLearningRelease, requireLearningResource, type LearningResourcePointer, type LearningTransaction } from "./repository.js";

type ReserveCommand = Extract<LearningCommand, { action: "reserve_iteration" }>;

/** The caller owns one scope-serialized transaction. This never submits a Job. */
export async function reserveLearningIteration(transaction: LearningTransaction, input: ReserveCommand, actorId: string, now: string): Promise<LearningResourcePointer[]> {
  const policy = await requireLearningRelease(transaction, "policy", input.policy);
  const chainId = learningChainId(policy.modelProjectId);
  const trigger = input.trigger.kind === "schedule" ? { ...input.trigger, scheduledAt: new Date(input.trigger.scheduledAt).toISOString() } : input.trigger;
  const triggerIdentity = contentHash([input.policy.id, trigger]);
  const id = `iteration-${contentHash([chainId, triggerIdentity])}`;
  const requestHash = contentHash({ policy: input.policy, trigger });
  const previous = await transaction.get("reservation", id);
  if (previous) {
    if (previous.requestHash !== requestHash) throw new LearningDomainError("learning_trigger_identity_conflict", 409);
    // Fire identity is independent of actor and transport operation identity.
    return [{ kind: "iteration", id, revision: (await requireLearningResource(transaction, "iteration", id)).revision }, { kind: "reservation", id, revision: previous.revision }];
  }
  const current = await requireLearningResource(transaction, "policy", policy.id);
  if (!sameLearningRef(learningRef(current), input.policy)) throw new LearningDomainError("learning_policy_revision_stale", 409);
  if (!policy.enabled) throw new LearningDomainError("learning_policy_paused", 409);
  if (policy.automation.accept || policy.automation.serve) throw new LearningDomainError("learning_automatic_acceptance_not_available", 422);
  if (input.trigger.kind === "schedule") {
    if (policy.trigger.kind !== "schedule" || !policy.automation.train) throw new LearningDomainError("learning_schedule_not_enabled", 409);
    if (Date.parse(input.trigger.scheduledAt) > Date.parse(now)) throw new LearningDomainError("learning_schedule_not_due", 409);
  }
  const chain = await transaction.get("chain", chainId);
  if (chain?.activeIterationId) throw new LearningDomainError("learning_iteration_active", 409, chain.activeIterationId);
  if (chain?.lastReservedAt && Date.parse(now) - Date.parse(chain.lastReservedAt) < policy.limits.cooldownSeconds * 1_000) {
    throw new LearningDomainError("learning_iteration_cooldown", 409);
  }
  const eligibility = await inspectIterationEligibility(transaction, policy);
  const ready = eligibility.counts.eligible >= policy.admission.minimumApprovedExamples;
  const status = ready ? "ready" : eligibility.counts.awaitingReview > 0 ? "waiting_for_review" : "waiting_for_data";
  const pointers: LearningResourcePointer[] = [];
  let batch = null;
  if (ready) {
    await assertAvailableBudget(transaction, chainId, now, policy.limits.maxIterationSpendUsd, policy.limits.maxDailySpendUsd);
    const sealed = await sealLearningBatch(transaction, {
      action: "seal_batch", operationId: input.operationId, batchId: `batch-${contentHash(id)}`,
      taskDefinition: policy.taskDefinition, purpose: eligibility.purpose,
      evidence: eligibility.selected.map((item) => learningRef(item.evidence)),
      decisions: eligibility.selected.map((item) => learningRef(item.decision)),
    }, actorId, now);
    pointers.push(...sealed);
    batch = learningRef(await requireLearningResource(transaction, "batch", sealed[0]!.id));
    for (const item of eligibility.selected) {
      const consumption = LearningConsumptionSchema.parse({
        schemaVersion: "openpond.learningConsumption.v1", id: learningConsumptionId(chainId, item.evidence), revision: 1,
        chainId, iterationId: id, evidence: learningRef(item.evidence), decision: learningRef(item.decision), reservedAt: now,
      });
      await transaction.put("consumption", consumption, 0, { parentId: chainId });
    }
  }
  const iteration = LearningIterationSchema.parse({
    schemaVersion: "openpond.learningIteration.v1", id, revision: 1, policy: input.policy, status,
    triggerIdentity, batch,
    // Existing evidence has no ordered ingress sequence. Consumption records,
    // not a count or lexicographic ID cursor, decide whether an example is new.
    sourceWatermarks: {}, trainingParent: policy.trainingParent, teacher: policy.teacher, upstreamEvent: null,
    trainingJob: null, evaluationJob: null, candidateVersion: null, dispatchId: `dispatch-${contentHash(id)}`,
    retryCount: 0, spendUsd: 0, failure: null, createdAt: now, updatedAt: now,
  });
  const reservation = LearningIterationReservationSchema.parse({
    schemaVersion: "openpond.learningIterationReservation.v1", id, revision: 1, chainId, iterationId: id,
    policy: input.policy, trigger, requestHash, outcome: ready ? "reserved" : status,
    counts: eligibility.counts,
    budget: { maximumSpendUsd: ready ? policy.limits.maxIterationSpendUsd : 0, reservedSpendUsd: ready ? policy.limits.maxIterationSpendUsd : 0, settledSpendUsd: 0, settledAt: ready ? null : now },
    createdAt: now, updatedAt: now,
  });
  const updatedChain = LearningChainSchema.parse({
    schemaVersion: "openpond.learningChain.v1", id: chainId, revision: (chain?.revision ?? 0) + 1,
    modelProjectId: policy.modelProjectId, activeIterationId: ready ? id : null, latestIterationId: id,
    lastReservedAt: ready ? now : chain?.lastReservedAt ?? null, updatedAt: now,
  });
  await transaction.put("iteration", iteration, 0, { parentId: chainId, status });
  await transaction.put("reservation", reservation, 0, { parentId: chainId, status: reservation.outcome });
  await transaction.put("chain", updatedChain, chain?.revision ?? 0, { parentId: policy.modelProjectId });
  return [{ kind: "iteration", id, revision: 1 }, { kind: "reservation", id, revision: 1 }, ...pointers];
}

async function assertAvailableBudget(transaction: LearningTransaction, chainId: string, now: string, requested: number, maximum: number) {
  let committed = 0;
  let afterId: string | undefined;
  do {
    const page = await transaction.list("reservation", { parentId: chainId, limit: 100, ...(afterId ? { afterId } : {}) });
    for (const { budget } of page.items) {
      // Unsettled reservations carry across midnight and worker restarts.
      committed += budget.reservedSpendUsd;
      if (budget.settledAt && new Date(budget.settledAt).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)) committed += budget.settledSpendUsd;
    }
    afterId = page.nextCursor ?? undefined;
  } while (afterId);
  if (committed + requested > maximum) throw new LearningDomainError("learning_daily_budget_exhausted", 409);
}
