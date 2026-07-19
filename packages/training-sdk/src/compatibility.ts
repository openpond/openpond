import {
  estimateTrainingTaskSizing,
  TrainingCompatibilityReportSchema,
  type Taskset,
  type TrainingDestinationCapabilities,
  type TrainingPlan,
} from "@openpond/contracts";

export function validateTrainingCompatibility(input: {
  taskset: Taskset;
  plan: TrainingPlan;
  capabilities: TrainingDestinationCapabilities;
}) {
  const issues: Array<{ code: string; severity: "warning" | "error"; path: string | null; message: string }> = [];
  if (!input.capabilities.available) issues.push({ code: "destination_unavailable", severity: "error", path: "destinationId", message: input.capabilities.unavailableReason ?? "Destination is unavailable." });
  if (!input.capabilities.methods.includes(input.plan.recipe.method)) issues.push({ code: "method_unsupported", severity: "error", path: "recipe.method", message: `${input.plan.destinationId} does not support ${input.plan.recipe.method}.` });
  if (!input.capabilities.parameterizations.includes(input.plan.recipe.parameterization)) issues.push({ code: "parameterization_unsupported", severity: "error", path: "recipe.parameterization", message: `${input.plan.destinationId} does not support ${input.plan.recipe.parameterization}.` });
  const methodDeclared = input.taskset.capabilities.compatibleMethods.includes(
    input.plan.recipe.method,
  ) || input.taskset.readiness?.trainingPath?.bootstrap?.method === input.plan.recipe.method;
  if (!methodDeclared) issues.push({
    code: "taskset_method_incompatible",
    severity: "error",
    path: "taskset.capabilities.compatibleMethods",
    message: `Taskset does not declare ${input.plan.recipe.method} compatibility or a staged ${input.plan.recipe.method} bootstrap.`,
  });
  const executableRecipe = input.plan.recipe.method === "sft" || input.plan.recipe.method === "grpo";
  const baseModelId = input.plan.recipe.method === "sft"
    ? input.plan.recipe.baseModel.id
    : input.plan.recipe.method === "grpo"
      ? input.plan.recipe.baseModel.id
      : "";
  if (input.capabilities.modelAllowlist.length && !input.capabilities.modelAllowlist.includes(baseModelId)) issues.push({ code: "model_unsupported", severity: "error", path: "recipe.baseModel", message: "Base model is not in the destination allowlist." });
  if (!executableRecipe) issues.push({ code: "recipe_not_executable", severity: "error", path: "recipe.method", message: `OpenPond has no proven executable ${input.plan.recipe.method} recipe contract yet.` });
  const recipe = input.plan.recipe;
  if (recipe.method === "sft") {
    const maxSequenceLength = recipe.dataset.maxSequenceLength;
    const trainTasks = input.taskset.tasks.filter((task) => task.split === recipe.dataset.trainSplit);
    const sizedTasks = trainTasks.map((task) => ({ task, sizing: estimateTrainingTaskSizing(task) }));
    if (recipe.dataset.completionOnly) {
      const oversizedTargets = sizedTasks.filter(({ sizing }) => sizing.maximumAssistantTargetTokens > maxSequenceLength);
      if (oversizedTargets.length) issues.push({ code: "training_completions_truncated", severity: "error", path: "recipe.dataset.maxSequenceLength", message: `${oversizedTargets.length} training trajector${oversizedTargets.length === 1 ? "y has" : "ies have"} an assistant target that cannot fit at ${maxSequenceLength} tokens. Increase the sequence length or shorten the target before training.` });
      const truncatedContexts = sizedTasks.filter(({ sizing }) => sizing.renderedTokens > maxSequenceLength && sizing.maximumAssistantTargetTokens <= maxSequenceLength);
      if (truncatedContexts.length) issues.push({ code: "training_context_truncated", severity: "warning", path: "recipe.dataset.maxSequenceLength", message: `Completion-only projection will preserve every assistant target but left-truncate prior context in ${truncatedContexts.length} training trajector${truncatedContexts.length === 1 ? "y" : "ies"} at ${maxSequenceLength} tokens.` });
    } else {
      const oversized = sizedTasks.filter(({ sizing }) => sizing.renderedTokens > maxSequenceLength);
      if (oversized.length) issues.push({ code: "training_examples_truncated", severity: "error", path: "recipe.dataset.maxSequenceLength", message: `${oversized.length} training example${oversized.length === 1 ? " is" : "s are"} likely to be truncated at ${maxSequenceLength} tokens. Increase the sequence length or shorten the examples before training.` });
    }
    const trainCount = trainTasks.length;
    if (trainCount < 8) issues.push({ code: "training_dataset_small", severity: "warning", path: "taskset.tasks", message: `${trainCount} training example${trainCount === 1 ? " is" : "s are"} sufficient for a pipeline test, not evidence of useful model quality.` });
  }
  if (recipe.method === "grpo") {
    const trainTasks = input.taskset.tasks.filter((task) => task.split === recipe.dataset.trainSplit);
    if (!trainTasks.length) issues.push({ code: "rft_train_split_empty", severity: "error", path: "taskset.tasks", message: "RFT requires at least one approved train prompt." });
    const baselineReward = input.taskset.readiness?.baselineReward ?? null;
    const hasRewardVariance = Boolean(
      input.taskset.readiness?.baselineReportId
      && baselineReward
      && baselineReward.count >= 2
      && (baselineReward.variance ?? 0) > 0
      && (baselineReward.mean ?? 0) > 0.05
      && (baselineReward.mean ?? 0) < 0.95,
    );
    if (!hasRewardVariance) {
      issues.push({
        code: "rft_reward_variance_missing",
        severity: "error",
        path: "taskset.readiness.baselineReward",
        message: "Paid RFT requires a current frozen baseline with non-trivial eligible reward variance and a policy that reaches both passing and failing reward states.",
      });
    }
    if (!input.capabilities.environmentPlacements.includes("provider_native")) issues.push({ code: "rft_environment_placement", severity: "error", path: "environmentPlacement", message: "RFT requires a provider-native rollout environment placement." });
    if (input.plan.destinationId !== "fireworks") issues.push({ code: "rft_destination_unproven", severity: "error", path: "destinationId", message: "The executable GRPO contract is currently proven only for Fireworks." });
    if (input.plan.environmentPlacement !== "provider_native") issues.push({ code: "rft_plan_placement", severity: "error", path: "environmentPlacement", message: "The GRPO plan must use provider-native placement." });
  }
  return TrainingCompatibilityReportSchema.parse({ schemaVersion: "openpond.trainingCompatibility.v1", compatible: !issues.some((issue) => issue.severity === "error"), destinationId: input.plan.destinationId, tasksetId: input.taskset.id, recipeMethod: input.plan.recipe.method, issues, checkedAt: new Date().toISOString() });
}
