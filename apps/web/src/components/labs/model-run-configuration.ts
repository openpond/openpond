import type { ModelComparisonSeriesEntry, TrainingStateResponse } from "@openpond/contracts";
import type { labModelPlans } from "./lab-models";

export function runConfiguration(
  plan: ReturnType<typeof labModelPlans>[number] | null,
): Array<{ label: string; value: string }> {
  if (!plan) return [];
  const recipe = plan.recipe;
  if (recipe.method === "grpo") {
    return [
      { label: "LoRA rank", value: String(recipe.lora.rank) },
      {
        label: "Learning rate",
        value: scientificNumber(recipe.optimizer.learningRate),
      },
      { label: "Optimizer steps", value: String(recipe.optimizer.maxSteps) },
      { label: "Rollouts per update", value: String(recipe.rollout.groupSize) },
      { label: "Rollout concurrency", value: String(recipe.rollout.concurrency) },
      {
        label: "Max output tokens",
        value: recipe.rollout.maxOutputTokens.toLocaleString(),
      },
      { label: "Temperature", value: String(recipe.rollout.temperature) },
      { label: "Top P", value: String(recipe.rollout.topP) },
    ];
  }
  if (recipe.method === "sft" || recipe.method === "dpo") {
    return [
      { label: "LoRA rank", value: String(recipe.lora.rank) },
      {
        label: "Learning rate",
        value: scientificNumber(recipe.optimizer.learningRate),
      },
      { label: "Optimizer steps", value: String(recipe.optimizer.maxSteps) },
    ];
  }
  return [];
}

export function continuationConfiguration(
  state: TrainingStateResponse | null,
  entry: ModelComparisonSeriesEntry | null,
): Array<{ label: string; value: string }> {
  if (!state || !entry) return [];
  if (entry.parent.kind === "base_model") {
    return [
      {
        label: "Starting checkpoint",
        value: `Frozen base · ${entry.parent.revision}`,
      },
      { label: "Optimizer", value: "Fresh" },
    ];
  }
  const parentVersion = state.modelVersions.find(
    (version) => version.id === entry.parent.id,
  );
  const parentEntry = state.comparisonSeriesEntries.find(
    (candidate) =>
      candidate.seriesId === entry.seriesId &&
      candidate.modelVersionId === entry.parent.id,
  );
  const checkpoint = [
    parentEntry?.label ?? null,
    parentVersion ? `Version ${parentVersion.version}` : entry.parent.id,
  ].filter((value): value is string => Boolean(value)).join(" · ");
  return [
    { label: "Starting checkpoint", value: checkpoint },
    { label: "Optimizer", value: "Fresh" },
  ];
}

export function comparisonParentLabel(
  state: TrainingStateResponse | null,
  entry: ModelComparisonSeriesEntry | null,
): string {
  if (!state || !entry || entry.parent.kind === "base_model") return "Frozen base";
  const parentEntry = state.comparisonSeriesEntries.find(
    (candidate) =>
      candidate.seriesId === entry.seriesId
      && candidate.modelVersionId === entry.parent.id,
  );
  const parentVersion = state.modelVersions.find(
    (version) => version.id === entry.parent.id,
  );
  return [
    parentEntry?.label ?? "Prior checkpoint",
    parentVersion ? `Version ${parentVersion.version}` : null,
  ].filter((value): value is string => Boolean(value)).join(" · ");
}

function scientificNumber(value: number): string {
  return value === 0 ? "0" : value.toExponential(2);
}
