export function TrainingManualGoalStep({
  objective,
  onChange,
  onContinue,
}: {
  objective: string;
  onChange: (value: string) => void;
  onContinue: () => void;
}) {
  const valid = Boolean(objective.trim());
  return (
    <>
      <div className="training-dialog-scroll-body">
        <div className="training-run-step-heading">
          <h3>What should the model learn?</h3>
          <p>Describe a repeatable capability or outcome. You can add successful chats and corrections next.</p>
        </div>
        <label className="training-objective-field">
          <span>Capability <small>Required</small></span>
          <textarea
            data-autofocus
            required
            value={objective}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && valid) onContinue();
            }}
            placeholder="For example: reconcile renewal, billing, and support risk across customer systems"
          />
        </label>
      </div>
      <div className="training-dialog-actions">
        <button className="training-button" type="button" disabled={!valid} onClick={onContinue}>Add evidence</button>
      </div>
    </>
  );
}
