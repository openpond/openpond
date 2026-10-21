import type { TrainingRecipe } from "@openpond/contracts";

const parameterLabels: Record<TrainingRecipe["parameterization"], string> = {
  lora: "LoRA adapters",
  full: "All model weights",
};

export function TrainingParameterSummary({ recipe }: { recipe: TrainingRecipe }) {
  return (
    <div>
      <dt>Updated parameters</dt>
      <dd>{parameterLabels[recipe.parameterization]}</dd>
    </div>
  );
}
