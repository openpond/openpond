import type { AlphaEditExperimentFormDraft } from "openpond-sdk/training";

const trainingLabels: Record<keyof AlphaEditExperimentFormDraft["training"], string> = {
  maxSteps: "Maximum optimizer steps",
  learningRate: "Learning rate",
  klFactor: "KL preservation weight",
  latentWeightDecay: "Latent weight decay",
  clampNormFactor: "Target norm clamp factor",
  maxSequenceLength: "Maximum sequence tokens",
  maxDurationSeconds: "Maximum duration (seconds)",
  maxForwardTokenWork: "Maximum forward token work",
  maxCheckpointBytes: "Maximum checkpoint bytes",
  seed: "Seed",
};

export function AlphaEditFields({
  form,
  onChange,
}: {
  form: AlphaEditExperimentFormDraft;
  onChange(form: AlphaEditExperimentFormDraft): void;
}) {
  return (
    <>
      <p>
        Edit factual associations in the exact managed backbone. Preservation examples define the
        covariance used to constrain the weight update.
      </p>
      <label>
        Rewrite layers (comma separated)
        <input
          value={form.config.layers}
          maxLength={200}
          onChange={(event) =>
            onChange({ ...form, config: { ...form.config, layers: event.target.value } })
          }
        />
      </label>
      <label>
        Loss layer
        <input
          inputMode="numeric"
          value={form.config.lossLayer}
          maxLength={100}
          onChange={(event) =>
            onChange({ ...form, config: { ...form.config, lossLayer: event.target.value } })
          }
        />
      </label>
      <label>
        Context template groups (JSON)
        <textarea
          rows={4}
          value={form.config.contextTemplateGroups}
          maxLength={65_536}
          onChange={(event) =>
            onChange({
              ...form,
              config: { ...form.config, contextTemplateGroups: event.target.value },
            })
          }
        />
      </label>
      <p>
        Each template contains one {"{}"} placeholder. The first group contains only the clean
        prompt template.
      </p>
      <label>
        Nullspace threshold
        <input
          inputMode="decimal"
          value={form.config.nullspaceThreshold}
          maxLength={100}
          onChange={(event) =>
            onChange({
              ...form,
              config: { ...form.config, nullspaceThreshold: event.target.value },
            })
          }
        />
      </label>
      <label>
        L2 regularization
        <input
          inputMode="decimal"
          value={form.config.l2}
          maxLength={100}
          onChange={(event) =>
            onChange({ ...form, config: { ...form.config, l2: event.target.value } })
          }
        />
      </label>
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
    </>
  );
}
