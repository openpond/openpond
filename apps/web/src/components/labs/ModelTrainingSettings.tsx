import { useRef, useState } from "react";
import { RftRecipeSchema, type ModelProject } from "@openpond/contracts";
import { TrainingRunSizeControl } from "../training/TrainingRunSizeControl";
import { trainingSmokeIncompatibility, trainingSmokeRecipe } from "../training/training-run-presets";

type Recipe = ModelProject["trainingSetup"]["recipe"];
const fields = [
  { section: "optimizer", key: "maxSteps", label: "Training steps", min: 1, max: 100_000, step: 1 },
  { section: "optimizer", key: "learningRate", label: "Learning rate", min: Number.MIN_VALUE, step: "any" },
  { section: "rollout", key: "maxOutputTokens", label: "Maximum answer tokens", min: 1, max: 8_192, step: 1 },
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function modelTrainingSettingsProblem(recipe: Recipe): string | null {
  if (recipe?.method !== "grpo") return null;
  for (const field of fields) {
    const value = record(recipe[field.section])[field.key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < field.min
      || ("max" in field && value > field.max) || (field.step === 1 && !Number.isInteger(value))) return `Enter a valid value for ${field.label.toLowerCase()}.`;
  }
  return null;
}

export function ModelTrainingSettings({ recipe, onChange }: { recipe: Recipe; onChange: (recipe: Recipe) => void }) {
  const initial = useRef(recipe);
  const [custom, setCustom] = useState(false);
  const parsed = RftRecipeSchema.safeParse(recipe);
  const current = parsed.success ? parsed.data : null;
  const smoke = current && trainingSmokeIncompatibility("small_experiment", "grpo", {
    maxSteps: current.optimizer.maxSteps, trainingExamples: current.dataset.maxExamples,
    rolloutGroupSize: current.rollout.groupSize, rolloutConcurrency: current.rollout.concurrency,
    optimizerIterations: current.optimizer.iterations, maximumRollouts: current.resourceLimits.maxRollouts,
  }) === null;
  const preset = smoke && !custom ? "small_experiment" : "custom";
  if (recipe?.method !== "grpo") return null;
  function update(section: string, key: string, raw: string) {
    if (!recipe) return;
    const value = raw === "" ? "" : Number(raw);
    const next: Recipe = { ...recipe, [section]: { ...record(recipe[section]), [key]: value } };
    if (key === "maxSteps" && typeof value === "number") {
      const groupSize = record(recipe.rollout).groupSize;
      if (typeof groupSize === "number") next.resourceLimits = { ...record(recipe.resourceLimits), maxRollouts: value * groupSize };
    }
    setCustom(true);
    onChange(next);
  }
  return <>
    <TrainingRunSizeControl method="grpo" value={preset} disabled={!current}
      sizing={current ? { prompts: current.dataset.maxExamples, rollouts: current.rollout.groupSize, groups: current.optimizer.maxSteps, iterations: current.optimizer.iterations, concurrency: current.rollout.concurrency } : undefined}
      onSizingChange={value => { if (current) { setCustom(true); onChange({ ...current, dataset: { ...current.dataset, maxExamples: value.prompts }, rollout: { ...current.rollout, groupSize: value.rollouts, concurrency: value.concurrency }, optimizer: { ...current.optimizer, maxSteps: value.groups, iterations: value.iterations }, resourceLimits: { ...current.resourceLimits, maxRollouts: value.rollouts * value.groups }, policyOptimization: null }); } }} onChange={next => {
      setCustom(next === "custom");
      if (next === "small_experiment" && current) onChange(trainingSmokeRecipe(current));
      else if (next === "standard") onChange(initial.current);
    }} />
    <details className="model-training-settings">
    <summary>Training settings</summary>
    <p>GRPO with LoRA. Review the cost and budget before starting a Run.</p>
    <div className="taskset-draft-field-grid">{fields.map(field => {
      const value = record(recipe[field.section])[field.key];
      return <label key={field.key}><span>{field.label}</span>
        <input type="number" min={field.min} max={"max" in field ? field.max : undefined} step={field.step}
          value={typeof value === "number" || typeof value === "string" ? value : ""}
          onChange={event => update(field.section, field.key, event.target.value)} />
      </label>;
    })}</div>
  </details></>;
}
