import { ReleaseIdSchema, ReleaseTimestampSchema } from "@openpond/harness";
import { z } from "zod";

import { LearningRevisionRefSchema, learningRef, sameLearningRef } from "./contracts.js";
import { prepareLearningBatch } from "./batch-service.js";
import { LearningDomainError } from "./errors.js";
import { readLearningIterationBudget } from "./iteration-budget.js";
import { inspectIterationEligibility, learningChainId } from "./iteration-eligibility.js";
import { LearningChainSchema, LearningEligibilityCountsSchema } from "./iteration-reservation-contracts.js";
import { requireLearningRelease, requireLearningResource, type LearningTransaction } from "./repository.js";

/** A scope-serialized snapshot of shared reservation readiness, not a Job guarantee.
 * No iteration, timer, batch, consumption or operation record is written. */
export const LearningPolicyInspectionResultSchema = z.object({
  policy: LearningRevisionRefSchema,
  modelProjectId: ReleaseIdSchema,
  inspectedAt: ReleaseTimestampSchema,
  chain: LearningChainSchema.nullable(),
  counts: LearningEligibilityCountsSchema.nullable(),
  minimumApprovedExamples: z.number().int().positive(),
  canReserve: z.boolean(),
  blockers: z.array(z.object({ code: z.string().min(1).max(200), message: z.string().min(1).max(20_000) }).strict()).max(20),
  cooldownUntil: ReleaseTimestampSchema.nullable(),
  budget: z.object({
    reservedSpendUsd: z.number().nonnegative(), settledSpendUsd: z.number().nonnegative(), committedSpendUsd: z.number().nonnegative(),
    maximumIterationSpendUsd: z.number().nonnegative(), maximumDailySpendUsd: z.number().nonnegative(),
  }).strict(),
}).strict();
export type LearningPolicyInspectionResult = z.infer<typeof LearningPolicyInspectionResultSchema>;

export async function inspectLearningPolicy(transaction: LearningTransaction, reference: z.infer<typeof LearningRevisionRefSchema>, actorId: string, now: string): Promise<LearningPolicyInspectionResult> {
  const policy = await requireLearningRelease(transaction, "policy", reference);
  const current = await requireLearningResource(transaction, "policy", policy.id);
  if (!sameLearningRef(learningRef(current), reference)) throw new LearningDomainError("learning_policy_revision_stale", 409);
  const chainId = learningChainId(policy.modelProjectId);
  const chain = await transaction.get("chain", chainId);
  const budget = await readLearningIterationBudget(transaction, chainId, now);
  const blockers: LearningPolicyInspectionResult["blockers"] = [];
  const block = (code: string, message: string) => { blockers.push({ code, message }); };
  if (!policy.enabled) block("learning_policy_paused", "Learning is paused.");
  if (policy.automation.accept || policy.automation.serve) block("learning_automatic_acceptance_not_available", "Candidates require explicit acceptance and serving selection.");
  if (chain?.activeIterationId) block("learning_iteration_active", "An iteration is already active.");
  const cooldownUntil = chain?.lastReservedAt && Date.parse(now) - Date.parse(chain.lastReservedAt) < policy.limits.cooldownSeconds * 1_000
    ? new Date(Date.parse(chain.lastReservedAt) + policy.limits.cooldownSeconds * 1_000).toISOString() : null;
  if (cooldownUntil) block("learning_iteration_cooldown", "The training cooldown has not elapsed.");
  if (budget.committedSpendUsd + policy.limits.maxIterationSpendUsd > policy.limits.maxDailySpendUsd) {
    block("learning_daily_budget_exhausted", "The daily budget cannot cover another iteration's maximum spend.");
  }
  let counts: LearningPolicyInspectionResult["counts"] = null;
  try {
    const eligibility = await inspectIterationEligibility(transaction, policy);
    counts = eligibility.counts;
    if (counts.eligible < policy.admission.minimumApprovedExamples) {
      if (counts.awaitingReview > 0) block("learning_waiting_for_review", "More approved tasks are required before training.");
      else block("learning_waiting_for_data", "More eligible new tasks are required before training.");
    } else {
      await prepareLearningBatch(transaction, {
        action: "seal_batch", operationId: "policy-inspection", batchId: "policy-inspection",
        taskDefinition: policy.taskDefinition, purpose: eligibility.purpose,
        evidence: eligibility.selected.map(item => learningRef(item.evidence)),
        decisions: eligibility.selected.map(item => learningRef(item.decision)),
      }, actorId, now);
    }
  } catch (error) {
    if (!(error instanceof LearningDomainError)) throw error;
    // An unavailable count is not zero. Invalid sources or unsupported admission
    // must remain visible while the Model's settings and history can still load.
    block(error.code, error.message.slice(0, 20_000));
  }
  return LearningPolicyInspectionResultSchema.parse({
    policy: learningRef(policy), modelProjectId: policy.modelProjectId, inspectedAt: now, chain,
    counts, minimumApprovedExamples: policy.admission.minimumApprovedExamples, canReserve: blockers.length === 0,
    blockers, cooldownUntil,
    budget: { ...budget, maximumIterationSpendUsd: policy.limits.maxIterationSpendUsd, maximumDailySpendUsd: policy.limits.maxDailySpendUsd },
  });
}
