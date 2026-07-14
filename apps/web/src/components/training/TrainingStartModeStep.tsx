import { Search, SquarePen } from "../icons";

export type NewModelMode = "automated" | "manual";

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
];

export function TrainingStartModeStep({
  mode,
  onChange,
  onContinue,
}: {
  mode: NewModelMode | null;
  onChange: (mode: NewModelMode) => void;
  onContinue: () => void;
}) {
  return (
    <>
      <div className="training-run-step-heading">
        <h3>How do you want to start?</h3>
        <p>OpenPond will recommend the right intervention after it understands the work and evidence.</p>
      </div>
      <div className="training-method-options training-start-mode-options" role="radiogroup" aria-label="How to start a new model">
        {MODES.map((option) => {
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
              <Icon size={17} />
              <span><strong>{option.title}</strong><small>{option.description}</small></span>
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
