import { Boxes } from "../icons";

export function TrainingBaseModelStep({
  modelIds,
  value,
  onChange,
  onContinue,
}: {
  modelIds: string[];
  value: string;
  onChange: (modelId: string) => void;
  onContinue: () => void;
}) {
  return (
    <>
      <div className="training-run-step-heading">
        <h3>Choose a base model</h3>
        <p>Select the intended starting model. OpenPond checks method and provider compatibility again before any paid training launch.</p>
      </div>
      <div
        aria-label="Available base models"
        className="training-base-model-options"
        role="radiogroup"
      >
        {modelIds.map((modelId, index) => {
          const selected = modelId === value;
          return (
            <button
              key={modelId}
              aria-checked={selected}
              className={selected ? "selected" : undefined}
              data-autofocus={selected || (!value && index === 0) ? true : undefined}
              role="radio"
              type="button"
              onClick={() => onChange(modelId)}
              onDoubleClick={onContinue}
            >
              <span className="training-base-model-icon" aria-hidden="true">
                <Boxes size={18} />
              </span>
              <span className="training-base-model-copy">
                <strong>{baseModelLabel(modelId)}</strong>
                <small>{modelId}</small>
              </span>
              <span className="training-base-model-tags" aria-hidden="true">
                <small>Fireworks</small>
                <small>LoRA</small>
              </span>
              <span className="training-choice-indicator" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <p className="training-start-note">
        You can change the base model for an individual version before launch. Paid training still requires confirmation.
      </p>
      <div className="training-dialog-actions">
        <button className="training-button" type="button" disabled={!value} onClick={onContinue}>Continue</button>
      </div>
    </>
  );
}

function baseModelLabel(modelId: string): string {
  const name = modelId.split("/").filter(Boolean).at(-1) ?? modelId;
  return name
    .replace(/(\d+)p(\d+)b/gi, "$1.$2B")
    .replace(/(\d+)b/gi, "$1B")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
}
