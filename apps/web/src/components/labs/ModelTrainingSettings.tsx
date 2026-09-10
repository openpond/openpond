import type { ModelProject } from "@openpond/contracts";

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
  if (recipe?.method !== "grpo") return null;
  function update(section: string, key: string, raw: string) {
    if (!recipe) return;
    const value = raw === "" ? "" : Number(raw);
    const next: Recipe = { ...recipe, [section]: { ...record(recipe[section]), [key]: value } };
    if (key === "maxSteps" && typeof value === "number") {
      const groupSize = record(recipe.rollout).groupSize;
      if (typeof groupSize === "number") next.resourceLimits = { ...record(recipe.resourceLimits), maxRollouts: value * groupSize };
    }
    onChange(next);
  }
  return <details className="model-training-settings">
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
  </details>;
}
