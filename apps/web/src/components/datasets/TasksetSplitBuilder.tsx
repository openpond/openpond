import { useState } from "react";
import type { TaskDataDraft } from "@openpond/contracts";

import { newTask } from "./taskset-draft-editor-helpers";

export function TasksetSplitBuilder({
  disabled,
  objective,
  onCreate,
}: {
  disabled: boolean;
  objective: string;
  onCreate: (tasks: TaskDataDraft[]) => void;
}) {
  const [trainPrompts, setTrainPrompts] = useState(objective.trim());
  const [validationPrompts, setValidationPrompts] = useState("");
  const [frozenPrompts, setFrozenPrompts] = useState("");
  const count = lines(trainPrompts).length
    + lines(validationPrompts).length
    + lines(frozenPrompts).length;

  return (
    <details className="taskset-draft-advanced taskset-split-builder">
      <summary>Add scenarios by split</summary>
      <div className="taskset-draft-section">
        <p>
          Each line becomes one request to the model. Training prompts may update
          weights, validation prompts tune the workflow, and frozen-evaluation
          prompts remain untouched until the final comparison.
        </p>
        <div className="taskset-draft-field-grid three">
          <PromptList
            disabled={disabled}
            label="Training prompts"
            value={trainPrompts}
            onChange={setTrainPrompts}
          />
          <PromptList
            disabled={disabled}
            label="Validation prompts"
            value={validationPrompts}
            onChange={setValidationPrompts}
          />
          <PromptList
            disabled={disabled}
            label="Frozen evaluation prompts"
            value={frozenPrompts}
            onChange={setFrozenPrompts}
          />
        </div>
        <button
          className="training-button secondary"
          disabled={disabled || count === 0}
          type="button"
          onClick={() => onCreate([
            ...tasks(trainPrompts, "train"),
            ...tasks(validationPrompts, "validation"),
            ...tasks(frozenPrompts, "frozen_eval"),
          ])}
        >
          Add {count} scenario{count === 1 ? "" : "s"}
        </button>
      </div>
    </details>
  );
}

function PromptList({
  disabled,
  label,
  value,
  onChange,
}: {
  disabled: boolean;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="taskset-draft-field">
      <span>{label}</span>
      <textarea
        disabled={disabled}
        placeholder="One prompt per line"
        rows={6}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function tasks(value: string, split: TaskDataDraft["split"]): TaskDataDraft[] {
  return lines(value).map((prompt) => newTask({ prompt, split }));
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
