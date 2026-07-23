import {
  PolicyOptimizationComparisonSchema,
  type PolicyOptimizationContract,
  type TrainingPlan,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

export function comparePolicyOptimizationPlans(
  first: TrainingPlan,
  second: TrainingPlan,
) {
  const grpo = contractFor(first, "grpo");
  const ppo = contractFor(second, "ppo");
  const mismatches: Array<
    "dataset"
    | "policy_model"
    | "reference_model"
    | "environment"
    | "reward"
    | "rollout_budget"
    | "evaluation"
  > = [];
  if (
    grpo.dataset.tasksetId !== ppo.dataset.tasksetId
    || grpo.dataset.tasksetHash !== ppo.dataset.tasksetHash
    || grpo.dataset.selectionStrategy !== ppo.dataset.selectionStrategy
    || grpo.dataset.selectionSeed !== ppo.dataset.selectionSeed
    || grpo.dataset.maxExamples !== ppo.dataset.maxExamples
  ) mismatches.push("dataset");
  if (contentHash(grpo.policyModel) !== contentHash(ppo.policyModel)) {
    mismatches.push("policy_model");
  }
  if (contentHash(grpo.referenceModel) !== contentHash(ppo.referenceModel)) {
    mismatches.push("reference_model");
  }
  if (contentHash(grpo.environment) !== contentHash(ppo.environment)) {
    mismatches.push("environment");
  }
  if (contentHash(grpo.reward) !== contentHash(ppo.reward)) {
    mismatches.push("reward");
  }
  const grpoBudget = rolloutBudget(grpo);
  const ppoBudget = rolloutBudget(ppo);
  if (contentHash(grpoBudget) !== contentHash(ppoBudget)) {
    mismatches.push("rollout_budget");
  }
  if (grpo.evaluationSplit !== ppo.evaluationSplit) {
    mismatches.push("evaluation");
  }
  return PolicyOptimizationComparisonSchema.parse({
    schemaVersion: "openpond.policyOptimizationComparison.v1",
    grpoPlanId: first.id,
    ppoPlanId: second.id,
    comparable: mismatches.length === 0,
    shared: mismatches.length ? null : {
      tasksetId: grpo.dataset.tasksetId,
      tasksetHash: grpo.dataset.tasksetHash,
      policyModelHash: contentHash(grpo.policyModel),
      referenceModelHash: contentHash(grpo.referenceModel),
      environmentHash: contentHash(grpo.environment),
      rewardHash: contentHash(grpo.reward),
      rolloutBudgetHash: contentHash(grpoBudget),
      evaluationSplit: "frozen_eval",
    },
    mismatches,
  });
}

function contractFor(
  plan: TrainingPlan,
  method: "grpo" | "ppo",
): PolicyOptimizationContract {
  if (plan.recipe.method !== method) {
    throw new Error(`Expected a ${method.toUpperCase()} Training Plan.`);
  }
  const contract = plan.recipe.policyOptimization;
  if (!contract) {
    throw new Error(`${method.toUpperCase()} plan has no shared policy-optimization contract.`);
  }
  return contract;
}

function rolloutBudget(contract: PolicyOptimizationContract) {
  return {
    maxRollouts: contract.budgets.maxRollouts,
    maxEnvironmentExecutions: contract.budgets.maxEnvironmentExecutions,
    maxInputTokens: contract.budgets.maxInputTokens,
    maxOutputTokens: contract.budgets.maxOutputTokens,
  };
}
