import type { ActivationExperimentFormDraft } from "openpond-sdk/training";

export function initialActivationForm(): ActivationExperimentFormDraft {
  return {
    baseModel: null,
    prompts: [{ id: crypto.randomUUID(), text: "" }],
    coordinates: [{ id: crypto.randomUUID(), layer: "", neuron: "", dose: "1" }],
    doseMultipliers: "-1, 0, 1",
    normalization: {
      mode: "baseline_prompt_residual_median",
      statistic: "midpoint_median_fp32",
      sample: "non_padding_prompt_after_position_zero",
    },
    tokenScope: { phase: "prompt_and_decode", positions: "all_non_padding" },
    maxNewTokens: "32",
    maximumCapturedValues: "65536",
    maximumForwardTokenWork: "1000000",
    maximumDurationSeconds: "300",
    maximumSpendUsd: "",
  };
}
