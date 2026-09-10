import { contentHash } from "@openpond/harness";
import type { executeJavaScriptVerifier } from "../javascript-verifier.js";
import { verifyLearningTextAsset } from "./assets.js";
import { createBudgetedJudgeExecutor } from "./judge-budget.js";
import { createBoundModelJudgeRunner, type BoundJudgeRequest, type BoundJudgeResponse } from "./model-judge.js";
import { createRewardCheckJudgeBudgetStore } from "./reward-check-budget.js";
import { createIsolatedRewardFixtureExecutor } from "./reward-fixture-executor.js";
import { requireLearningResource, type LearningRepository } from "./repository.js";
import type { RewardCheckRun, RewardCheckRuntime } from "./reward-checks.js";
import type { RewardFixtureExecutor } from "./reward-check-worker.js";

export interface BoundJudgeProvider {
  /** Resolve exact model configuration and a conservative charge ceiling without
   * performing inference. dispatch settles after the provider request closes. */
  prepare(request: BoundJudgeRequest): Promise<{ maximumChargeUsd: number; dispatch(signal?: AbortSignal): Promise<BoundJudgeResponse> }>;
  cancel(input: { scope: string; run: Pick<RewardCheckRun, "id" | "judgeCalls"> }): Promise<boolean>;
}

export function createBudgetedRewardFixtureExecutor(options: {
  runtime: RewardCheckRuntime; repository: LearningRepository; provider: BoundJudgeProvider;
  executeJavaScript: typeof executeJavaScriptVerifier;
}): RewardFixtureExecutor {
  return createIsolatedRewardFixtureExecutor({
    runtime: options.runtime, executeJavaScript: options.executeJavaScript,
    async cancelModelJudge(input) {
      const run = await options.repository.transaction(input.scope, tx => requireLearningResource(tx, "reward_check", input.run.id));
      if (run.judgeCalls?.some(call => call.status === "reserved")) return false;
      return options.provider.cancel({ ...input, run });
    },
    async createModelJudge(input) {
      const budget = createRewardCheckJudgeBudgetStore({ repository: options.repository, scope: input.scope, run: input.run });
      return createBoundModelJudgeRunner({
        async readRubric(reference) {
          const asset = input.assets.find(asset => asset.id === reference.id);
          if (!asset) throw new Error("reward_check_rubric_missing");
          return verifyLearningTextAsset(asset, reference);
        },
        async executeBudgeted(request, signal) {
          const prepared = await options.provider.prepare(request);
          const execute = createBudgetedJudgeExecutor({ store: budget, maximumCharge: () => prepared.maximumChargeUsd, dispatch: (_request, signal) => prepared.dispatch(signal) });
          return execute(`fixture-${contentHash([input.fixture, input.reward.contentHash])}`, request, signal);
        },
      });
    },
  });
}
