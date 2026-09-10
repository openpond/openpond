import { contentHash } from "@openpond/harness";
import type { JudgeBudgetStore } from "./judge-budget.js";
import { requireLearningResource, type LearningRepository } from "./repository.js";
import { TaskGradeRunSchema, type TaskGradeRun } from "./contracts.js";

export function createTaskGradeJudgeBudgetStore(input: {
  repository: LearningRepository; scope: string; run: TaskGradeRun; now?: () => string;
}): JudgeBudgetStore {
  const now = input.now ?? (() => new Date().toISOString());
  const identity = (run: TaskGradeRun) => contentHash([run.evidence, run.binding, run.target, run.output]);
  return {
    transaction(intent, update) {
      return input.repository.transaction(input.scope, async tx => {
        const current = await requireLearningResource(tx, "grade", input.run.id);
        if (identity(current) !== identity(input.run)) throw new Error("model_judge_budget_snapshot_changed");
        if (intent === "dispatch" && (current.status !== "running" || !current.leaseOwner || current.leaseOwner !== input.run.leaseOwner
          || current.attemptCount !== input.run.attemptCount || !current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= Date.parse(now()))) throw new Error("model_judge_budget_owner_inactive");
        const calls = current.judgeCalls ?? [];
        const next = update({ maximumSpendUsd: current.maximumSpendUsd, calls });
        if (contentHash(next.calls) !== contentHash(calls)) {
          const updated = TaskGradeRunSchema.parse({ ...current, revision: current.revision + 1, judgeCalls: next.calls, updatedAt: now() });
          await tx.put("grade", updated, current.revision, { parentId: current.evidence.id, status: current.status });
        }
        return next.result;
      });
    },
  };
}
