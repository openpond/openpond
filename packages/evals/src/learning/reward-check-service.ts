import { LearningDomainError } from "./errors.js";
import { currentDraft } from "./authoring-service.js";
import { learningRef } from "./contracts.js";
import { compileRewardCheck, RewardCheckRunSchema } from "./reward-checks.js";
import { LearningConflictError, requireLearningRelease, requireLearningResource, type LearningTransaction } from "./repository.js";
import type { LearningCommand } from "./operations.js";

export async function queueRewardCheck(tx: LearningTransaction, input: Extract<LearningCommand, { action: "queue_reward_check" }>, operationId: string, now: string, requestedBy: string) {
  const draft = await currentDraft(tx, input.draft);
  if (draft.targetKind !== "reward") throw new LearningDomainError("reward_check_draft_kind_invalid", 422);
  const base = draft.baseRelease ? await requireLearningRelease(tx, "reward", draft.baseRelease) : null;
  const compiled = compileRewardCheck(draft, base);
  const check = RewardCheckRunSchema.parse({
    schemaVersion: "openpond.rewardCheckRun.v1", id: `reward-check-${operationId}`, revision: 1,
    draft: learningRef(draft), reward: learningRef(compiled.reward), snapshotHash: compiled.snapshotHash,
    fixtureRefs: compiled.fixtureRefs, status: "queued", runtime: null, results: [], matchesExpectations: null,
    timeoutMs: input.timeoutMs, maximumSpendUsd: input.maximumSpendUsd, requestedBy,
    leaseOwner: null, leaseExpiresAt: null, attemptCount: 0, failure: null, createdAt: now, updatedAt: now,
  });
  await tx.put("reward_check", check, 0, { parentId: draft.targetId, status: check.status });
  return { kind: "reward_check" as const, id: check.id, revision: check.revision };
}

export async function cancelRewardCheck(tx: LearningTransaction, input: Extract<LearningCommand, { action: "cancel_reward_check" }>, now: string) {
  const check = await requireLearningResource(tx, "reward_check", input.checkId);
  if (check.revision !== input.expectedRevision) throw new LearningConflictError("reward_check", check.id, input.expectedRevision, check.revision);
  if (["completed", "failed", "cancelled"].includes(check.status)) return { kind: "reward_check" as const, id: check.id, revision: check.revision };
  const updated = RewardCheckRunSchema.parse({ ...check, revision: check.revision + 1, status: check.status === "queued" ? "cancelled" : "cancelling", updatedAt: now });
  await tx.put("reward_check", updated, check.revision, { parentId: check.reward.id, status: updated.status });
  return { kind: "reward_check" as const, id: updated.id, revision: updated.revision };
}
