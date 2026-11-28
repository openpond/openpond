import { createModelTrainingRecipeDefaults } from "openpond-sdk/model-starters";
import type { ModelProject } from "@openpond/contracts";
import { ModelTrainingSettings } from "../labs/ModelTrainingSettings";
import { ResourceSetupDraftSchema, type ResourceSetupDraft } from "../../lib/resource-setup-prompt";

type Recipe = ModelProject["trainingSetup"]["recipe"];
type BaseModel = ModelProject["trainingSetup"]["baseModel"];

function settingsSection(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function modelSetupTrainingRecipe(draft: ResourceSetupDraft, method: "sft" | "grpo", baseModel?: BaseModel): NonNullable<Recipe> {
  const saved = draft.trainingRecipes?.[method];
  if (saved) return saved;
  const defaults = createModelTrainingRecipeDefaults(null, method, baseModel);
  const { epochs, learningRate } = draft.values;
  return { ...defaults, optimizer: {
    ...settingsSection(defaults.optimizer),
    ...(epochs !== undefined && method === "sft" ? { epochs } : {}),
    ...(learningRate !== undefined ? { learningRate } : {}),
  } };
}

export function ModelSetupTrainingFields({ draft, method, baseModel, disabled, onChange }: {
  draft: ResourceSetupDraft;
  method: "sft" | "grpo";
  baseModel?: BaseModel;
  disabled: boolean;
  onChange(current: ResourceSetupDraft, next: ResourceSetupDraft): void;
}) {
  const recipe = modelSetupTrainingRecipe(draft, method, baseModel);
  const dataset = settingsSection(recipe.dataset);
  const maxExamples = dataset.maxExamples;

  function change(next: Recipe) {
    if (!next || next.method !== method) return;
    const updated = ResourceSetupDraftSchema.parse({
      ...draft,
      revision: draft.revision + 1,
      trainingRecipes: { ...draft.trainingRecipes, [method]: next },
      values: { ...draft.values, epochs: undefined, learningRate: undefined },
    });
    onChange(draft, updated);
  }

  return <fieldset className="resource-setup-fields resource-setup-training-fields" disabled={disabled}
    onKeyDown={event => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
    <legend>Training settings</legend>
    <label className="resource-setup-input">Training examples
      <input type="number" min={1} max={method === "sft" ? 1_000 : 100_000}
        value={typeof maxExamples === "number" || typeof maxExamples === "string" ? maxExamples : ""}
        onChange={event => change({ ...recipe, dataset: {
          ...dataset, maxExamples: event.target.value === "" ? "" : event.target.valueAsNumber,
        } })} />
    </label>
    <ModelTrainingSettings recipe={recipe} onChange={change} />
  </fieldset>;
}
