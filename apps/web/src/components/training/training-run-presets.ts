import type { ModelRunPreset, RftRecipe, TrainingMethod } from "@openpond/contracts";

export type TrainingRunMethod = "sft" | "dpo" | "grpo" | "ppo";

export function isTrainingSmoke(preset: ModelRunPreset): boolean {
  return preset === "small" || preset === "small_experiment";
}

export function trainingSmokeLimits(method: TrainingRunMethod) {
  return {
    maxSteps: 1,
    trainingExamples: method === "grpo" ? 1 : method === "sft" ? 4 : 2,
    rolloutGroupSize: 4,
    rolloutConcurrency: 1,
  };
}

export function trainingRunDefaults(preset: ModelRunPreset, method: TrainingRunMethod,
  defaults: { maxSteps: number; rolloutGroupSize: number; rolloutConcurrency: number }) {
  if (!isTrainingSmoke(preset)) return defaults;
  const limits = trainingSmokeLimits(method);
  return { maxSteps: limits.maxSteps, rolloutGroupSize: limits.rolloutGroupSize, rolloutConcurrency: limits.rolloutConcurrency };
}

export function trainingSmokeRecipe(recipe: RftRecipe): RftRecipe {
  const limits = trainingSmokeLimits("grpo");
  return {
    ...recipe,
    dataset: { ...recipe.dataset, maxExamples: limits.trainingExamples },
    rollout: { ...recipe.rollout, groupSize: limits.rolloutGroupSize, concurrency: limits.rolloutConcurrency },
    optimizer: { ...recipe.optimizer, maxSteps: limits.maxSteps, iterations: 2, gradientAccumulationSteps: limits.rolloutGroupSize },
    resourceLimits: { ...recipe.resourceLimits, maxRollouts: limits.rolloutGroupSize },
    // Preparation rebuilds the execution projection from the reviewed recipe.
    policyOptimization: null,
  };
}

export function trainingRunPresets(method: TrainingMethod | null): Array<{
  id: ModelRunPreset; label: string; description: string;
}> {
  const online = method === "grpo" || method === "ppo";
  return [
    { id: "standard", label: "Full run", description: "Pre-fill the full training configuration, then adjust its limits." },
    {
      id: online ? "small_experiment" : "small",
      label: "Smoke",
      description: method === "grpo"
        ? "Start with 1 prompt, 4 rollouts, 1 group, and 2 optimizer iterations."
        : "Start with a small training batch and 1 optimizer step.",
    },
    { id: "custom", label: "Custom", description: "Choose prompts, rollouts, groups, and optimizer iterations." },
  ];
}

// Check the effective launch configuration, including saved recipes and catalog defaults.
// A preset label must never disguise a larger paid run.
export function trainingSmokeIncompatibility(
  preset: ModelRunPreset,
  method: TrainingRunMethod,
  configuration: { maxSteps: number; trainingExamples: number; rolloutGroupSize: number; rolloutConcurrency: number; optimizerIterations?: number; maximumRollouts?: number },
): string | null {
  if (!isTrainingSmoke(preset)) return null;
  const limits = trainingSmokeLimits(method);
  if (configuration.maxSteps > limits.maxSteps || configuration.trainingExamples > limits.trainingExamples
    || ((method === "grpo" || method === "ppo") && (configuration.rolloutGroupSize > limits.rolloutGroupSize
      || configuration.rolloutConcurrency > limits.rolloutConcurrency
      || (configuration.optimizerIterations ?? 2) > 2 || (configuration.maximumRollouts ?? 4) > 4))) {
    return "These settings exceed the training smoke test limits. Reduce them or select Custom.";
  }
  return null;
}
