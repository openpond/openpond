import { ManagedSftRecipeSchema } from "openpond-sdk/training";
import type { ModelProject } from "@openpond/contracts";
import { DropdownSelect } from "../DropdownSelect";

type Recipe = NonNullable<ModelProject["trainingSetup"]["recipe"]>;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const targets = ManagedSftRecipeSchema.shape.lora.shape.targetModules.element.options;
const fields = [
  { section: "optimizer", key: "learningRate", label: "Learning rate", min: Number.MIN_VALUE, max: 0.001, step: "any" },
  { section: "optimizer", key: "epochs", label: "Epochs", min: Number.MIN_VALUE, max: 10, step: "any" },
  { section: "optimizer", key: "batchSize", label: "Batch size", min: 1, max: 32, step: 1 },
  { section: "optimizer", key: "gradientAccumulationSteps", label: "Gradient accumulation steps", min: 1, max: 32, step: 1 },
  { section: "optimizer", key: "seed", label: "Seed", min: -(2 ** 31), max: 2 ** 31 - 1, step: 1 },
  { section: "dataset", key: "maxSequenceLength", label: "Maximum sequence tokens", min: 2, max: 8192, step: 1 },
  { section: "lora", key: "rank", label: "LoRA rank", min: 1, max: 64, step: 1 },
  { section: "lora", key: "alpha", label: "LoRA alpha", min: Number.MIN_VALUE, max: 1024, step: "any" },
  { section: "lora", key: "dropout", label: "LoRA dropout", min: 0, max: 1, step: "any" },
] as const;

/** Validate editable settings without inventing a model or dataset binding.
 * Full preparation and runtime qualification remain authoritative on Run. */
export function supervisedTrainingSettingsProblem(recipe: Recipe): string | null {
  const checks = [
    ManagedSftRecipeSchema.shape.optimizer.safeParse(recipe.optimizer),
    ManagedSftRecipeSchema.shape.lora.safeParse(recipe.lora),
    ManagedSftRecipeSchema.shape.dataset.omit({ trainSplit: true, validationSplit: true }).safeParse(recipe.dataset),
  ];
  for (const result of checks) if (!result.success) {
    const issue = result.error.issues[0];
    return `${issue?.path.join(".") || "SFT settings"}: ${issue?.message ?? "Check this value."}`;
  }
  const optimizer = record(recipe.optimizer);
  if (Number(optimizer.batchSize) * Number(optimizer.gradientAccumulationSteps) > 32)
    return "Managed SFT supports at most 32 accumulated examples.";
  const modules = record(recipe.lora).targetModules;
  if (Array.isArray(modules) && new Set(modules).size !== modules.length)
    return "Choose each adapter target module once.";
  return null;
}

export function SupervisedTrainingSettings({ recipe, onChange }: { recipe: Recipe; onChange: (recipe: Recipe) => void }) {
  const optimizer = record(recipe.optimizer);
  const modules = record(recipe.lora).targetModules;
  const selected = Array.isArray(modules) ? modules.filter((item): item is string => typeof item === "string") : [];
  const effectiveBatch = typeof optimizer.batchSize === "number" && Number.isFinite(optimizer.batchSize) && typeof optimizer.gradientAccumulationSteps === "number" && Number.isFinite(optimizer.gradientAccumulationSteps)
    ? optimizer.batchSize * optimizer.gradientAccumulationSteps : null;
  function update(section: string, key: string, value: unknown) {
    onChange({ ...recipe, [section]: { ...record(recipe[section]), [key]: value } });
  }
  const numeric = (section: string, key: string) => {
    const value = record(recipe[section])[key];
    return typeof value === "number" || typeof value === "string" ? value : "";
  };
  return <>
    <label className="model-build-field"><span>Training steps</span>
      <input type="number" min={1} max={128} step={1} value={numeric("optimizer", "maxSteps")}
        onChange={event => update("optimizer", "maxSteps", event.target.value === "" ? "" : event.target.valueAsNumber)} />
    </label>
    <details className="model-training-settings">
      <summary>Advanced SFT settings</summary>
      <p>SFT with LoRA. Available settings depend on the selected model and runtime.</p>
      <div className="taskset-draft-field-grid">{fields.map(field => <label className="labs-model-create-field" key={`${field.section}.${field.key}`}>
        <span>{field.label}</span><input type="number" min={field.min} max={field.max} step={field.step}
          value={numeric(field.section, field.key)} onChange={event => update(field.section, field.key, event.target.value === "" ? "" : event.target.valueAsNumber)} />
      </label>)}</div>
      <p>{effectiveBatch !== null ? `${effectiveBatch} example${effectiveBatch === 1 ? "" : "s"} per optimizer update` : "Examples per optimizer update depend on batch size and gradient accumulation."}</p>
      <details><summary>Adapter targets</summary>
        {selected.map((value, index) => <div className="labs-model-create-select-row" key={index}>
          <DropdownSelect floating label={`Adapter target ${index + 1}`} value={value}
            options={[
              ...(!targets.some(target => target === value) ? [{ value, label: `${value} (unavailable)`, disabled: true }] : []),
              ...targets.map(target => ({ value: target, label: target, disabled: target !== value && selected.includes(target) })),
            ]}
            onChange={next => update("lora", "targetModules", selected.map((item, position) => position === index ? next : item))} />
          <button type="button" className="training-text-button" aria-label={`Remove adapter target ${value}`}
            disabled={selected.length <= 1} onClick={() => update("lora", "targetModules", selected.filter((_, position) => position !== index))}>Remove</button>
        </div>)}
        {selected.length < targets.length ? <DropdownSelect floating label="Add adapter target" value=""
          options={[{ value: "", label: "Add target module", disabled: true }, ...targets.filter(target => !selected.includes(target)).map(target => ({ value: target, label: target }))]}
          onChange={value => update("lora", "targetModules", [...selected, value])} /> : null}
      </details>
    </details>
  </>;
}
