import type { NeuronTrainingExperimentFormDraft } from "openpond-sdk/training";
import { DropdownSelect } from "../../DropdownSelect";

const selectionLabels = {
  count: "Selected neuron count",
  maximumBackgroundTargetRatio: "Maximum background to target activation ratio",
  gradientExamples: "Gradient selection examples",
} as const;
const trainingLabels: Record<keyof NeuronTrainingExperimentFormDraft["training"], string> = {
  learningRate: "Learning rate",
  maxSteps: "Maximum optimizer steps",
  gradientAccumulationSteps: "Gradient accumulation steps",
  maxSequenceLength: "Maximum sequence tokens",
  preservationWeight: "Preservation weight",
  preservationExamplesPerStep: "Preservation examples per step",
  seed: "Seed",
  maxDurationSeconds: "Maximum duration (seconds)",
  maxCheckpointBytes: "Maximum checkpoint bytes",
  maximumForwardTokenWork: "Maximum forward token work",
};

export function NeuronTrainingFields({
  form,
  onChange,
}: {
  form: NeuronTrainingExperimentFormDraft;
  onChange(form: NeuronTrainingExperimentFormDraft): void;
}) {
  return (
    <>
      <p>
        Select neurons from reviewed target and background domains, then train only their output
        projection columns. The saved inference delta does not contain optimizer state.
      </p>
      <label>
        Selection span
        <DropdownSelect
          floating
          label="Selection span"
          value={form.selection.span}
          options={[
            { value: "reply_prediction", label: "Reply prediction" },
            { value: "reply_start", label: "Reply start" },
            { value: "prompt", label: "Prompt" },
          ]}
          onChange={(span) => {
            if (span === "reply_prediction" || span === "reply_start" || span === "prompt")
              onChange({ ...form, selection: { ...form.selection, span } });
          }}
        />
      </label>
      <label>
        Background statistic
        <DropdownSelect
          floating
          label="Background statistic"
          value={form.selection.backgroundStatistic}
          options={[
            { value: "max_domains", label: "Maximum across domains" },
            { value: "mean_domains", label: "Mean across domains" },
          ]}
          onChange={(backgroundStatistic) => {
            if (backgroundStatistic === "max_domains" || backgroundStatistic === "mean_domains")
              onChange({ ...form, selection: { ...form.selection, backgroundStatistic } });
          }}
        />
      </label>
      {(Object.keys(selectionLabels) as Array<keyof typeof selectionLabels>).map((key) => (
        <label key={key}>
          {selectionLabels[key]}
          <input
            inputMode="decimal"
            value={form.selection[key]}
            maxLength={100}
            onChange={(event) =>
              onChange({ ...form, selection: { ...form.selection, [key]: event.target.value } })
            }
          />
        </label>
      ))}
      <label>
        Explicit coordinates (optional)
        <textarea
          rows={5}
          value={form.selection.coordinates}
          maxLength={10_000}
          onChange={(event) =>
            onChange({ ...form, selection: { ...form.selection, coordinates: event.target.value } })
          }
        />
      </label>
      <p>
        Leave blank for automatic selection. Otherwise enter one layer:neuron coordinate per line;
        distinct coordinates must match the selected count.
      </p>
      {(Object.keys(trainingLabels) as Array<keyof typeof form.training>).map((key) => (
        <label key={key}>
          {trainingLabels[key]}
          <input
            inputMode="decimal"
            value={form.training[key]}
            maxLength={100}
            onChange={(event) =>
              onChange({ ...form, training: { ...form.training, [key]: event.target.value } })
            }
          />
        </label>
      ))}
      {form.inspectionSource ? (
        <p className="saved-model-version-reference">
          Selection evidence: {form.inspectionSource.result.executionId} · model{" "}
          {form.inspectionSource.modelHash}. The compiler reauthorizes this original inspection.
        </p>
      ) : null}
    </>
  );
}
