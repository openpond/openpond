import { useContext, useState } from "react";
import type { ChatResourceSummary } from "@openpond/contracts";
import {
  resourceSetupGroups,
  resourceSetupLabel,
  resourceSetupParts,
  ResourceSetupDraftSchema,
  type ResourceSetupDraft,
  type ResourceSetupField,
  type ResourceSetupPart,
} from "../../lib/resource-setup-prompt";
import type { DropdownOption } from "../../lib/app-models";
import { DropdownSelect } from "../DropdownSelect";
import { AppDialog } from "../dialogs/AppDialog";
import { ChevronDown, SlidersHorizontal } from "../icons";
import { DesktopNewContext } from "./DesktopNewMenu";
import "./resource-setup-editor.css";

type PromptField = Exclude<ResourceSetupPart, string>["field"];

const labels: Record<ResourceSetupField, string> = {
  name: "Name", objective: "Objective", baseModel: "Starting model or exact checkpoint",
  candidate: "Candidate version", baseline: "Baseline version", dataset: "Dataset",
  datasetRevision: "Dataset revision", split: "Split", grader: "Graders",
  method: "Training method", adapter: "Adapter", learning: "Continual learning", destination: "Execution destination",
  source: "Dataset source", graderType: "Grader type", fields: "Input and expected output fields",
  samples: "Sample count", epochs: "Epochs", learningRate: "Learning rate", seed: "Seed",
  budget: "Maximum spend in USD", criterion: "Scoring criterion", cases: "Passing and failing examples", project: "Project",
};
const choices: Partial<Record<ResourceSetupField, readonly string[]>> = {
  method: ["SFT", "GRPO", "Decision", "Weight-space programming"],
  adapter: ["LoRA", "Full fine-tuning"],
  learning: ["One-time training", "Configure continual learning"],
  source: ["Write examples", "Import a local file", "Use an existing dataset"],
  graderType: ["Code grader", "LLM judge", "Human assessment", "Python correctness"],
};
const decimalFields = new Set<ResourceSetupField>(["budget", "learningRate"]);
const integerFields = new Set<ResourceSetupField>(["datasetRevision", "epochs", "samples", "seed"]);

export function ResourceSetupEditor({ draft, busy, datasets, localBenchmarkAvailable, onChange, onRemove }: {
  draft: ResourceSetupDraft;
  busy: boolean;
  datasets: readonly ChatResourceSummary[];
  localBenchmarkAvailable: boolean;
  onChange(current: ResourceSetupDraft, next: ResourceSetupDraft): void;
  onRemove(): void;
}) {
  const managedAvailable = useContext(DesktopNewContext)?.managedAvailable ?? false;
  const [configureOpen, setConfigureOpen] = useState(false);
  const [field, setField] = useState<PromptField>("name");
  const parts = resourceSetupParts(draft);
  const localDatasets = datasets.filter(dataset => dataset.location !== "cloud");
  const datasetValue = (dataset: Pick<ChatResourceSummary, "id" | "revision">) => JSON.stringify([dataset.id, dataset.revision]);
  function showField(next: PromptField) {
    setField(next);
    setConfigureOpen(true);
  }
  function change(key: ResourceSetupField, raw: string) {
    const parsed = ResourceSetupDraftSchema.safeParse({
      ...draft,
      revision: draft.revision + 1,
      ...(key === "candidate" ? { candidateRef: undefined } : {}),
      values: { ...draft.values, [key]: raw === "" ? undefined : decimalFields.has(key) || integerFields.has(key) ? Number(raw) : raw },
    });
    if (parsed.success) onChange(draft, parsed.data);
  }
  function chooseDataset(value: string) {
    const reference = localDatasets.find(dataset => datasetValue(dataset) === value);
    onChange(draft, {
      ...draft,
      revision: draft.revision + 1,
      datasetRef: reference && { id: reference.id, revision: reference.revision, contentHash: reference.contentHash },
      values: { ...draft.values, dataset: reference?.name, datasetRevision: reference?.revision, grader: undefined },
    });
  }
  function fieldOptions(key: ResourceSetupField): DropdownOption[] | null {
    if (key === "destination") {
      const localReason = draft.kind === "model" ? "Training on this device is unavailable."
        : draft.kind === "benchmark" && !localBenchmarkAvailable ? "Configure a compatible loopback model in provider settings." : null;
      return [
        { value: "", label: "Choose a destination" },
        { value: "This device", label: "This device", disabled: Boolean(localReason), description: localReason ?? undefined },
        { value: "OpenPond Managed", label: "OpenPond Managed", disabled: !managedAvailable, description: managedAvailable ? undefined : "Sign in and select a workspace." },
      ];
    }
    const options = choices[key];
    return options ? [{ value: "", label: "Choose later" }, ...options.map(value => ({ value, label: value }))] : null;
  }
  const sentence = () => <div className="resource-setup-sentence">
    {parts.map((part, index) => typeof part === "string" ? part : <button key={index}
      className="resource-setup-pill" type="button" disabled={busy} aria-label={`Edit ${part.placeholder}`}
      data-active={configureOpen && part.field === field || undefined} onClick={() => showField(part.field)}>
      {resourceSetupLabel(part, draft)} <ChevronDown aria-hidden="true" size={12} />
    </button>)}
  </div>;
  const activePart = parts.find(part => typeof part !== "string" && part.field === field);
  const activeFields = resourceSetupGroups[field] ?? [field as ResourceSetupField];
  const benchmarkPresets = draft.kind === "benchmark" ? <div className="resource-setup-presets" role="group" aria-label="Benchmark presets">
    {[{ compare: false, label: "Evaluate one model" }, { compare: true, label: "Compare models" }].map(({ compare, label }) =>
      <button type="button" className="training-button secondary" key={label} disabled={busy}
        aria-pressed={Boolean(draft.comparison) === compare}
        onClick={() => onChange(draft, { ...draft, revision: draft.revision + 1, comparison: compare })}>{label}</button>)}
  </div> : null;
  return <div className="resource-setup-editor">
    {benchmarkPresets}
    {sentence()}
    <button type="button" className="training-text-button resource-setup-configure" disabled={busy} onClick={() => {
      setField(parts.find((part): part is Exclude<ResourceSetupPart, string> => typeof part !== "string")?.field ?? "name");
      setConfigureOpen(true);
    }}>
      <SlidersHorizontal size={13} aria-hidden="true" /> Configure
    </button>
    {configureOpen ? <AppDialog ariaLabel="Configure prompt" className="training-dialog resource-setup-dialog" initialFocusKey={field}
      onClose={() => setConfigureOpen(false)}>
      <h2>Configure prompt</h2>
      {sentence()}
      {benchmarkPresets}
      {activePart ? <div className="resource-setup-fields" key={field}>
        {activeFields.map((key, index) => {
          const options = fieldOptions(key);
          const label = field === "saveDestination" ? "Save to" : labels[key];
          if (key === "dataset" && localDatasets.length) {
            const value = draft.datasetRef ? datasetValue(draft.datasetRef) : "";
            const options = localDatasets.map(dataset => ({ value: datasetValue(dataset), label: `${dataset.name} revision ${dataset.revision}` }));
            const retained = value && !options.some(option => option.value === value)
              ? [{ value, label: draft.values.dataset ?? "Selected dataset revision" }] : [];
            return <div className="resource-setup-input" key={key}>
              <span>{label}</span>
              <DropdownSelect label={label} value={value} searchable
                options={[{ value: "", label: draft.values.dataset && !value ? draft.values.dataset : "Choose a local dataset" }, ...retained, ...options]}
                disabled={busy} onChange={chooseDataset} />
            </div>;
          }
          if (key === "datasetRevision" && draft.datasetRef) return null;
          return options ? <div className="resource-setup-input" key={key}>
            <span>{label}</span>
            <DropdownSelect label={label} options={options} value={String(draft.values[key] ?? "")}
              disabled={busy} onChange={value => change(key, value)} />
          </div> : <label className="resource-setup-input" key={key}>
            {label}
            <input
              data-autofocus={index === 0 || undefined}
              type={decimalFields.has(key) || integerFields.has(key) ? "number" : "text"}
              step={decimalFields.has(key) ? "any" : undefined}
              min={["datasetRevision", "epochs", "samples"].includes(key) ? 1 : 0}
              maxLength={2_000}
              disabled={busy}
              value={draft.values[key] ?? ""}
              onChange={event => change(key, event.target.value)}
              onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }}
            />
          </label>;
        })}
      </div> : null}
      <footer className="training-dialog-actions">
        <button type="button" className="training-button secondary" disabled={busy} onClick={onRemove}>Remove setup</button>
        <button type="button" className="training-button" onClick={() => setConfigureOpen(false)}>Done</button>
      </footer>
    </AppDialog> : null}
  </div>;
}
