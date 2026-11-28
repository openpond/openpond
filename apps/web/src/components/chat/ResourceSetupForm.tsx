import type { ReactNode } from "react";
import type { ResourceSetupDraft, ResourceSetupPart } from "../../lib/resource-setup-prompt";
import { ChevronDown, ChevronRight } from "../icons";
import type { DropdownOption } from "../../lib/app-models";

type Field = Exclude<ResourceSetupPart, string>["field"];
type Section = { label: string; fields: Field[] };

const sections: Record<ResourceSetupDraft["kind"], Section[]> = {
  model: [
    { label: "Model", fields: ["name", "objective", "method", "adapter", "baseModel"] },
    { label: "Dataset", fields: ["dataset", "weightSpacePanels", "weightSpaceFrozen"] },
    { label: "Graders", fields: ["grader"] },
    { label: "Continual learning", fields: ["learning"] },
    { label: "Compute & limits", fields: ["destination", "trainingSettings", "weightSpaceSettings"] },
  ],
  benchmark: [
    { label: "Models", fields: ["name", "objective", "candidate", "baseline"] },
    { label: "Dataset & graders", fields: ["dataset", "grader"] },
    { label: "Evaluation protocol", fields: ["destination", "evaluationSettings", "budget"] },
  ],
  dataset: [
    { label: "Dataset source", fields: ["name", "objective", "source", "dataset"] },
    { label: "Field mapping", fields: ["fields"] },
    { label: "Preview & save", fields: ["saveDestination", "preview"] },
  ],
  grader: [
    { label: "Grader type", fields: ["name", "graderType"] },
    { label: "Dataset & scoring", fields: ["dataset", "criterion"] },
    { label: "Grading examples", fields: ["cases"] },
  ],
  chat: [{ label: "Chat", fields: ["objective", "project"] }],
};

export function resourceFormSections(kind: ResourceSetupDraft["kind"], parts: ResourceSetupPart[]) {
  const fields = new Set(parts.flatMap(part => typeof part === "string" ? [] : [part.field]));
  return sections[kind].map(section => ({ ...section, fields: section.fields.filter(key => fields.has(key)) }))
    .filter(section => section.fields.length);
}

export function ResourceSetupForm({ sections, field, busy, onSection, render }: {
  sections: Section[];
  field: Field;
  busy: boolean;
  onSection(field: Field): void;
  render(fields: Field[]): ReactNode;
}) {
  return <div className="resource-setup-sections">
    {sections.map(section => {
      const open = section.fields.includes(field);
      return <section key={section.label} className="resource-setup-section">
        <h3><button type="button" aria-expanded={open} disabled={busy} onClick={() => onSection(section.fields[0]!)}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />} {section.label}
        </button></h3>
        {open && <div className="resource-setup-section-fields">{render(section.fields)}</div>}
      </section>;
    })}
  </div>;
}

const choiceLabels: Record<string, string> = {
  SFT: "Supervised fine-tuning (SFT)", GRPO: "Reinforcement learning (GRPO)", Decision: "Decision Model",
  "Write examples": "Write examples", "Import a local file": "Upload files", "Use an existing dataset": "Existing dataset",
};

export function SetupChoiceCards({ label, value, options, busy, onChange }: {
  label: string;
  value?: string;
  options: DropdownOption[];
  busy: boolean;
  onChange(value: string): void;
}) {
  return <fieldset className="resource-setup-choice-cards">
    <legend>{label}</legend>
    <div>{options.filter(option => option.value).map(option => <button key={option.value} type="button"
      disabled={busy || option.disabled} aria-pressed={value === option.value}
      title={option.description} onClick={() => onChange(option.value)}>
      {choiceLabels[option.value] ?? option.label}
    </button>)}</div>
  </fieldset>;
}
