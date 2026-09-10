import { contentHash } from "@openpond/harness";
import type { JudgeBudgetStore } from "./judge-budget.js";
import { requireLearningResource, type LearningRepository } from "./repository.js";
import { RewardCheckRunSchema, type RewardCheckRun } from "./reward-checks.js";

/** The same persisted run owns fixture results and budget reservations. A late
 * provider settlement is retained even after its worker loses the lease. */
export function createRewardCheckJudgeBudgetStore(input: {
  repository: LearningRepository; scope: string; run: RewardCheckRun; now?: () => string;
}): JudgeBudgetStore {
  const now = input.now ?? (() => new Date().toISOString());
  return {
    transaction(intent, update) {
      return input.repository.transaction(input.scope, async tx => {
        const current = await requireLearningResource(tx, "reward_check", input.run.id);
        if (current.snapshotHash !== input.run.snapshotHash) throw new Error("model_judge_budget_snapshot_changed");
        if (intent === "dispatch" && (current.status !== "running" || !current.leaseOwner || current.leaseOwner !== input.run.leaseOwner
          || current.attemptCount !== input.run.attemptCount || !current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= Date.parse(now()))) throw new Error("model_judge_budget_owner_inactive");
        const calls = current.judgeCalls ?? [];
        const next = update({ maximumSpendUsd: current.maximumSpendUsd, calls });
        if (contentHash(next.calls) !== contentHash(calls)) {
          const updated = RewardCheckRunSchema.parse({ ...current, revision: current.revision + 1, judgeCalls: next.calls, updatedAt: now() });
          await tx.put("reward_check", updated, current.revision, { parentId: current.reward.id, status: current.status });
        }
        return next.result;
      });
    },
  };
}
