import { Boxes, Search, SquarePen } from "../icons";

export type NewModelMode = "automated" | "manual";
export type NewModelSetup = NewModelMode | "existing_dataset";

const MODES = [
  {
    id: "automated" as const,
    title: "Automated",
    description: "Review repeated work in chats and recommend what, if anything, should be trained.",
    icon: Search,
  },
  {
    id: "manual" as const,
    title: "Manual",
    description: "Start from a capability you already want the model to learn.",
    icon: SquarePen,
  },
  {
    id: "existing_dataset" as const,
    title: "Existing Dataset",
    description: "Create the Model from a reviewed Dataset without changing its tasks, graders, or held-out Evals.",
    icon: Boxes,
  },
];

export function TrainingStartModeStep({
  mode,
  allowExistingDataset = false,
  targetLabel = "model",
  onChange,
  onContinue,
}: {
  mode: NewModelSetup | null;
  allowExistingDataset?: boolean;
  targetLabel?: string;
  onChange: (mode: NewModelSetup) => void;
  onContinue: () => void;
}) {
  const options = allowExistingDataset
    ? MODES
    : MODES.filter((option) => option.id !== "existing_dataset");
  return (
    <>
      <div className="training-run-step-heading">
        <h3>Choose a setup</h3>
        <p>Start from repeated work or define the capability yourself. OpenPond recommends the training method after reviewing the Dataset.</p>
      </div>
      <div
        aria-label={`How to start a new ${targetLabel}`}
        className="training-method-options training-start-mode-options"
        role="radiogroup"
      >
        {options.map((option) => {
          const Icon = option.icon;
          const selected = option.id === mode;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={selected ? "selected" : ""}
              onClick={() => onChange(option.id)}
              onDoubleClick={onContinue}
            >
              <span className="training-start-mode-icon" aria-hidden="true">
                <Icon size={18} />
              </span>
              <span className="training-start-mode-copy">
                <strong>{option.title}</strong>
                <small>{option.description}</small>
              </span>
              <span className="training-choice-indicator" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <div className="training-dialog-actions">
        <button className="training-button" type="button" disabled={!mode} onClick={onContinue}>Continue</button>
      </div>
    </>
  );
}
