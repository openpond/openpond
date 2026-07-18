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
      <div className="training-base-model-card">
        <label>
          <span>Base model</span>
          <select
            data-autofocus
            value={value}
            onChange={(event) => onChange(event.target.value)}
          >
            {modelIds.map((modelId) => (
              <option key={modelId} value={modelId}>{baseModelLabel(modelId)}</option>
            ))}
          </select>
        </label>
        <dl>
          <div><dt>Provider</dt><dd>Fireworks</dd></div>
          <div><dt>Parameterization</dt><dd>LoRA</dd></div>
          <div><dt>Final confirmation</dt><dd>Training page</dd></div>
        </dl>
      </div>
      <p className="training-start-note">
        This records a preferred base for the Model draft. Individual SFT or RFT runs may override it at the explicit configuration and spend gate.
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
