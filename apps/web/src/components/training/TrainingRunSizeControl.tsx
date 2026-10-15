import type { ModelRunPreset } from "@openpond/contracts";
import { DropdownSelect } from "../DropdownSelect";
import { isTrainingSmoke, trainingRunPresets, type TrainingRunMethod } from "./training-run-presets";

type RunQuantities = { prompts: number; rollouts: number; groups: number; iterations: number; concurrency: number };

export function TrainingRunSizeControl({ method, methods, onMethodChange, value, onChange, disabled, recommendedAvailable = true, sizing, onSizingChange }: {
  method: TrainingRunMethod | null;
  methods?: TrainingRunMethod[];
  onMethodChange?: (value: TrainingRunMethod) => void;
  value: ModelRunPreset;
  onChange: (value: ModelRunPreset) => void;
  disabled?: boolean;
  recommendedAvailable?: boolean;
  sizing?: RunQuantities;
  onSizingChange?: (value: RunQuantities) => void;
}) {
  const presets = trainingRunPresets(method).filter(preset => recommendedAvailable || preset.id !== "standard");
  const selectedValue = isTrainingSmoke(value) ? presets.find(preset => isTrainingSmoke(preset.id))!.id : value;
  return <div className="model-build-field training-run-configuration">
    <span>Run configuration</span>
    <DropdownSelect floating label="Run configuration" value={selectedValue}
      options={presets.map(preset => ({ value: preset.id, label: preset.label }))}
      onChange={next => onChange(next as ModelRunPreset)} disabled={disabled} />
    {sizing && onSizingChange ? <div className="training-run-quantities">
      {([
        ["prompts", "Prompts", "Training prompts", 1, 100000],
        ["rollouts", "Rollouts", "Rollouts per prompt", 2, 16],
        ["groups", "Groups", "Rollout groups", 1, 100000],
        ["iterations", "Iterations", "Optimizer iterations", method === "grpo" ? 2 : 1, method === "grpo" ? 16 : 100],
        ["concurrency", "Concurrent", "Concurrent rollouts", 1, sizing.rollouts],
      ] as const).map(([key, caption, label, min, max]) =>
        <label key={key} title={label}><span>{caption}</span><input aria-label={label} type="number" min={min} max={max} step={1} value={Number.isFinite(sizing[key]) ? sizing[key] : ""}
          disabled={disabled} onChange={event => onSizingChange({ ...sizing, [key]: event.target.valueAsNumber || min })} /></label>)}
      <div className="training-run-method"><span>Method</span>
        <DropdownSelect compact floating floatingMenuWidth={140} label="Training method" value={method ?? ""}
          options={(methods ?? (method ? [method] : [])).map(value => ({ value, label: value.toUpperCase() }))}
          disabled={disabled || !onMethodChange || !methods?.length}
          onChange={value => onMethodChange?.(value as TrainingRunMethod)} />
      </div>
    </div> : null}
  </div>;
}
