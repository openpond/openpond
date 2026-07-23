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
  const executableRecipe = input.plan.recipe.method === "sft"
    || input.plan.recipe.method === "dpo"
    || input.plan.recipe.method === "grpo"
    || input.plan.recipe.method === "ppo";
  const baseModelId = input.plan.recipe.method === "sft"
    ? input.plan.recipe.baseModel.id
    : input.plan.recipe.method === "dpo"
      ? input.plan.recipe.policyModel.id
    : input.plan.recipe.method === "ppo"
      ? input.plan.recipe.policyOptimization.policyModel.id
    : input.plan.recipe.method === "grpo"
      ? input.plan.recipe.baseModel.id
      : "";
  if (input.capabilities.modelAllowlist.length && !input.capabilities.modelAllowlist.includes(baseModelId)) issues.push({ code: "model_unsupported", severity: "error", path: "recipe.baseModel", message: "Base model is not in the destination allowlist." });
  if (!executableRecipe) issues.push({ code: "recipe_not_executable", severity: "error", path: "recipe.method", message: `OpenPond has no proven executable ${input.plan.recipe.method} recipe contract yet.` });
  const recipe = input.plan.recipe;
  if (recipe.method === "sft") {
    const maxSequenceLength = recipe.dataset.maxSequenceLength;
    const trainTasks = input.taskset.tasks.filter((task) => task.split === recipe.dataset.trainSplit);
    const sizedTasks = input.taskset.datasetArtifact
      ? []
      : trainTasks.map((task) => ({
          task,
          sizing: estimateTrainingTaskSizing(task),
        }));
    if (recipe.dataset.completionOnly) {
      const oversizedTargets = sizedTasks.filter(({ sizing }) => sizing.maximumAssistantTargetTokens > maxSequenceLength);
      if (oversizedTargets.length) issues.push({ code: "training_completions_truncated", severity: "error", path: "recipe.dataset.maxSequenceLength", message: `${oversizedTargets.length} training trajector${oversizedTargets.length === 1 ? "y has" : "ies have"} an assistant target that cannot fit at ${maxSequenceLength} tokens. Increase the sequence length or shorten the target before training.` });
      const truncatedContexts = sizedTasks.filter(({ sizing }) => sizing.renderedTokens > maxSequenceLength && sizing.maximumAssistantTargetTokens <= maxSequenceLength);
      if (truncatedContexts.length) issues.push({ code: "training_context_truncated", severity: "warning", path: "recipe.dataset.maxSequenceLength", message: `Completion-only projection will preserve every assistant target but left-truncate prior context in ${truncatedContexts.length} training trajector${truncatedContexts.length === 1 ? "y" : "ies"} at ${maxSequenceLength} tokens.` });
    } else {
      const oversized = sizedTasks.filter(({ sizing }) => sizing.renderedTokens > maxSequenceLength);
      if (oversized.length) issues.push({ code: "training_examples_truncated", severity: "error", path: "recipe.dataset.maxSequenceLength", message: `${oversized.length} training example${oversized.length === 1 ? " is" : "s are"} likely to be truncated at ${maxSequenceLength} tokens. Increase the sequence length or shorten the examples before training.` });
    }
    const trainCount = input.taskset.datasetArtifact?.splitCounts[
      recipe.dataset.trainSplit
    ] ?? trainTasks.length;
    if (trainCount < 8) issues.push({ code: "training_dataset_small", severity: "warning", path: "taskset.tasks", message: `${trainCount} training example${trainCount === 1 ? " is" : "s are"} sufficient for a pipeline test, not evidence of useful model quality.` });
  }
  if (recipe.method === "dpo") {
    const pairs = input.taskset.learningSignals.preferences.filter((signal) =>
      signal.approved);
    if (!pairs.length) {
      issues.push({
        code: "dpo_preferences_missing",
        severity: "error",
        path: "taskset.learningSignals.preferences",
        message: "DPO requires at least one approved chosen/rejected pair.",
      });
    }
    if (pairs.some((pair) => pair.chosen.trim() === pair.rejected.trim())) {
      issues.push({
        code: "dpo_preferences_invalid",
        severity: "error",
        path: "taskset.learningSignals.preferences",
        message: "DPO chosen and rejected responses must differ.",
      });
    }
    if (recipe.policyModel.tokenizerRevision !== recipe.referenceModel.tokenizerRevision
      || recipe.policyModel.chatTemplateHash !== recipe.referenceModel.chatTemplateHash) {
      issues.push({
        code: "dpo_reference_template_mismatch",
        severity: "error",
        path: "recipe.referenceModel",
        message: "DPO policy and reference models must use the same tokenizer revision and chat template.",
      });
    }
    if (!input.taskset.tasks.some((task) => task.split === recipe.dataset.validationSplit)) {
      issues.push({
        code: "dpo_frozen_eval_missing",
        severity: "error",
        path: "taskset.tasks",
        message: "DPO requires an independent frozen evaluation split.",
      });
    }
    if (input.plan.destinationId !== "local_cpu_fixture") {
      issues.push({
        code: "dpo_destination_unproven",
        severity: "error",
        path: "destinationId",
        message: "The executable DPO contract is currently proven only on the local CPU correctness destination.",
      });
    }
  }
  if (recipe.method === "ppo") {
    const rewardReady = input.taskset.learningSignals.rewards.some((signal) =>
      signal.approved && signal.executable);
    if (!rewardReady) {
      issues.push({
        code: "ppo_executable_reward_missing",
        severity: "error",
        path: "taskset.learningSignals.rewards",
        message: "PPO requires an approved executable verifier reward.",
      });
    }
    if (!input.taskset.capabilities.rewardKinds.some((kind) =>
      kind === "exact" || kind === "deterministic")) {
      issues.push({
        code: "ppo_reward_kind_unsupported",
        severity: "error",
        path: "taskset.capabilities.rewardKinds",
        message: "The controlled PPO executor accepts only exact or deterministic verifier rewards.",
      });
    }
    if (!input.taskset.tasks.some((task) => task.split === "frozen_eval")) {
      issues.push({
        code: "ppo_frozen_eval_missing",
        severity: "error",
        path: "taskset.tasks",
        message: "PPO requires an independent frozen evaluation split.",
      });
    }
    if (recipe.policyOptimization.optimizer.valueModel.id.trim() === "") {
      issues.push({
        code: "ppo_value_model_missing",
        severity: "error",
        path: "recipe.policyOptimization.optimizer.valueModel",
        message: "PPO requires a pinned value-model identity.",
      });
    }
    if (recipe.policyOptimization.optimizer.minibatchSize
      > recipe.policyOptimization.budgets.maxRollouts) {
      issues.push({
        code: "ppo_minibatch_exceeds_rollouts",
        severity: "error",
        path: "recipe.policyOptimization.optimizer.minibatchSize",
        message: "PPO minibatch size cannot exceed the bounded rollout count.",
      });
    }
    if (input.plan.destinationId !== "local_cpu_fixture") {
      issues.push({
        code: "ppo_destination_unproven",
        severity: "error",
        path: "destinationId",
        message: "The verifier-backed PPO correctness executor is currently proven only on the local CPU destination.",
      });
    }
    if (input.plan.environmentPlacement !== "local") {
      issues.push({
        code: "ppo_environment_placement",
        severity: "error",
        path: "environmentPlacement",
        message: "The controlled PPO executor requires a local verifier environment.",
      });
    }
  }
  if (recipe.method === "grpo") {
    const trainTasks = input.taskset.tasks.filter((task) => task.split === recipe.dataset.trainSplit);
    const trainCount = input.taskset.datasetArtifact?.splitCounts[
      recipe.dataset.trainSplit
    ] ?? trainTasks.length;
    if (!trainCount) issues.push({ code: "rft_train_split_empty", severity: "error", path: input.taskset.datasetArtifact ? "taskset.datasetArtifact.splitCounts.train" : "taskset.tasks", message: "RFT requires at least one approved train prompt." });
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
    if (input.plan.destinationId !== "fireworks") issues.push({ code: "rft_destination_unproven", severity: "error", path: "destinationId", message: "The executable RFT contract is currently proven only for Fireworks." });
    if (input.plan.environmentPlacement !== "provider_native") issues.push({ code: "rft_plan_placement", severity: "error", path: "environmentPlacement", message: "The RFT plan must use provider-native placement." });
  }
  return TrainingCompatibilityReportSchema.parse({ schemaVersion: "openpond.trainingCompatibility.v1", compatible: !issues.some((issue) => issue.severity === "error"), destinationId: input.plan.destinationId, tasksetId: input.taskset.id, recipeMethod: input.plan.recipe.method, issues, checkedAt: new Date().toISOString() });
}
