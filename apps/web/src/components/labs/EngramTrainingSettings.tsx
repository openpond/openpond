import type {
  EngramAdapterConfig,
  EngramExperimentFormDraft,
} from "openpond-sdk/training";

type Training = EngramExperimentFormDraft["training"];
type Field = {
  key: keyof Training;
  label: string;
  inputMode: "decimal" | "numeric";
};

const advancedFields: readonly Field[] = [
  { key: "learningRate", label: "Learning rate", inputMode: "decimal" },
  { key: "weightDecay", label: "Weight decay", inputMode: "decimal" },
  { key: "gradientAccumulationSteps", label: "Gradient accumulation steps", inputMode: "numeric" },
  { key: "maxSequenceLength", label: "Maximum sequence tokens", inputMode: "numeric" },
  { key: "seed", label: "Seed", inputMode: "numeric" },
  { key: "maxDurationSeconds", label: "Maximum training seconds", inputMode: "decimal" },
  { key: "maxCheckpointBytes", label: "Maximum checkpoint bytes", inputMode: "numeric" },
];

/** Raw text remains editable until the canonical preparation owner validates it.
 * The resolved architecture describes the module, not execution availability. */
export function EngramTrainingSettings({
  training,
  configuration,
  disabled = false,
  onChange,
}: {
  training: Training;
  configuration: EngramAdapterConfig | null;
  disabled?: boolean;
  onChange(training: Training): void;
}) {
  function update(key: keyof Training, value: string) {
    onChange({ ...training, [key]: value });
  }
  return (
    <>
      <label className="model-build-field">
        <span>Training steps</span>
        <input
          type="text"
          inputMode="numeric"
          value={training.maxSteps}
          disabled={disabled}
          maxLength={100}
          onChange={(event) => update("maxSteps", event.target.value)}
        />
      </label>
      <details className="model-training-settings">
        <summary>Advanced Engram settings</summary>
        <p>
          Train the memory adapter with batch size 1 and gradient clipping at 1.
          The base weights stay frozen.
        </p>
        <div className="taskset-draft-field-grid">
          {advancedFields.map((field) => (
            <label className="labs-model-create-field" key={field.key}>
              <span>{field.label}</span>
              <input
                type="text"
                inputMode={field.inputMode}
                value={training[field.key]}
                disabled={disabled}
                maxLength={100}
                onChange={(event) => update(field.key, event.target.value)}
              />
            </label>
          ))}
        </div>
        <p>
          Step, duration and checkpoint limits are validated before training.
          Preparation reviews the separate spend cap.
        </p>
        {configuration ? (
          <details>
            <summary>Fixed memory architecture</summary>
            <dl>
              <dt>Injection layers</dt>
              <dd>{configuration.injectLayers.join(", ")}</dd>
              <dt>N-gram orders</dt>
              <dd>
                Suffix {configuration.suffixOrders.join(", ")}; previous group{" "}
                {configuration.previousOrders.join(", ")}
              </dd>
              <dt>Memory tables</dt>
              <dd>
                {configuration.numHashes} hashes · {configuration.tableSize.toLocaleString()} rows
                · {configuration.perHashDim} dimensions per hash
              </dd>
              <dt>Adapter</dt>
              <dd>FP32 · alpha {configuration.alpha}</dd>
            </dl>
          </details>
        ) : null}
      </details>
    </>
  );
}
