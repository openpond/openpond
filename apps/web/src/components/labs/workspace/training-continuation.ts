import type { TrainingPreparationParent } from "openpond-sdk/training";

export const loraContinuationOptions: Array<{ value: TrainingPreparationParent["adapterMode"]; label: string }> = [
  { value: "shared", label: "Shared, update the existing adapter" },
  { value: "residual_append", label: "Stacked, freeze the parent and add an adapter" },
  { value: "sequential_merge", label: "Merged, merge the parent, then train a new adapter" },
];
