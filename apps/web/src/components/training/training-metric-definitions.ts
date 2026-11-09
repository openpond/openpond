import type { PolicyOptimizationMetric, SftStepMetric } from "@openpond/contracts";
import type { TrainingMetricSeries } from "./TrainingMetricWorkbench";

type SeriesDefinition<T> = { key: keyof T; id: string; label: string; format?: TrainingMetricSeries["format"] };

export const POLICY_SERIES: Array<SeriesDefinition<PolicyOptimizationMetric>> = [
  { key: "meanReward", id: "optimizer.reward", label: "Mean reward" },
  { key: "meanReturn", id: "optimizer.return", label: "Mean return" },
  { key: "learningRate", id: "optimizer.learning_rate", label: "Learning rate", format: "scientific" },
  { key: "policyLoss", id: "optimizer.policy_loss", label: "Policy loss" },
  { key: "valueLoss", id: "optimizer.value_loss", label: "Value loss" },
  { key: "gradientNorm", id: "optimizer.gradient_norm", label: "Gradient norm" },
  { key: "kl", id: "optimizer.kl", label: "Policy update KL" },
  { key: "behaviorPolicyKlPreUpdate", id: "optimizer.behavior_policy_kl", label: "Behavior-policy KL (pre-update)" },
  { key: "entropy", id: "optimizer.entropy", label: "Entropy" },
  { key: "policyClipFraction", id: "optimizer.policy_clip_fraction", label: "Post-update clip fraction", format: "percent" },
  { key: "behaviorPolicyClipFractionPreUpdate", id: "optimizer.behavior_policy_clip_fraction", label: "Behavior-policy clip fraction (pre-update)", format: "percent" },
  { key: "valueClipFraction", id: "optimizer.value_clip_fraction", label: "Value clip fraction", format: "percent" },
  { key: "explainedVariance", id: "optimizer.explained_variance", label: "Explained variance" },
];

export const STEP_SERIES: Array<SeriesDefinition<SftStepMetric>> = [
  { key: "loss", id: "optimizer.loss", label: "Loss" },
  { key: "reward", id: "optimizer.reward", label: "Reward" },
  { key: "policyLoss", id: "optimizer.policy_loss", label: "Policy loss" },
  { key: "advantageLoss", id: "optimizer.advantage_loss", label: "Advantage loss" },
  { key: "learningRate", id: "optimizer.learning_rate", label: "Learning rate", format: "scientific" },
  { key: "gradientNorm", id: "optimizer.gradient_norm", label: "Gradient norm" },
  { key: "meanTokenAccuracy", id: "train.token_accuracy", label: "Token accuracy", format: "percent" },
  { key: "preferenceAccuracy", id: "train.preference_accuracy", label: "Preference accuracy", format: "percent" },
  { key: "preferenceMargin", id: "train.preference_margin", label: "Preference margin" },
  { key: "chosenReward", id: "train.chosen_reward", label: "Chosen reward" },
  { key: "rejectedReward", id: "train.rejected_reward", label: "Rejected reward" },
  { key: "entropy", id: "optimizer.entropy", label: "Entropy" },
];

export function definedSeries<T extends { step: number }>(rows: T[], definitions: Array<SeriesDefinition<T>>): TrainingMetricSeries[] {
  return definitions.flatMap((definition) => {
    const points = rows.flatMap((row) => {
      const value = row[definition.key];
      return typeof value === "number" && Number.isFinite(value) ? [{ step: row.step, value }] : [];
    });
    return points.length ? [{ id: definition.id, label: definition.label, points, format: definition.format }] : [];
  });
}

