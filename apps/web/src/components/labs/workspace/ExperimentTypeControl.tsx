import { DropdownSelect } from "../../DropdownSelect";
import { useEvaluationSetup, type ExperimentOperationType } from "./EvaluationSetupState";

export function ExperimentTypeControl({ disabled = false }: { disabled?: boolean }) {
  const setup = useEvaluationSetup();
  const alphaEdit = setup.startingModel?.source === "alphaedit";
  const neuronTraining = setup.startingModel?.source === "neuron_training";
  const learnedSource = alphaEdit || neuronTraining;
  const decision = setup.startingModel?.source === "decision";
  const engram = setup.startingModel?.source === "engram";
  const steering = setup.startingModel?.source === "steering";
  const steeringReason =
    "This saved steering source requires a neuron steering experiment. Choose another starting model for this action.";
  return (
    <label>
      Modification
      <DropdownSelect
        label="Modification"
        floating
        value={setup.operationType}
        disabled={disabled}
        options={[
          {
            value: "alphaedit",
            label: "AlphaEdit",
            disabled:
              decision ||
              engram ||
              steering ||
              neuronTraining ||
              setup.startingModel?.source === "trained" ||
              Boolean(setup.trainingParent),
            description: "Edit facts using reviewed edit and preservation batches.",
          },
          {
            value: "selective_neuron_training",
            label: "Neuron training",
            disabled:
              learnedSource ||
              decision ||
              engram ||
              steering ||
              setup.startingModel?.source === "trained" ||
              Boolean(setup.trainingParent),
            description: neuronTraining
              ? "The saved inference delta contains no optimizer state; choose a managed base explicitly for new training."
              : "Select neuron columns from reviewed target and background domains.",
          },
          {
            value: "decision_model",
            label: "Decision model",
            disabled:
              learnedSource ||
              engram ||
              steering ||
              setup.startingModel?.source === "trained" ||
              Boolean(setup.trainingParent),
            description: "Train or score typed decisions using an exact Decision adapter.",
          },
          {
            value: "evaluate",
            label: "Evaluate",
            disabled:
              learnedSource || decision || engram || steering || Boolean(setup.trainingParent),
            description: steering
              ? steeringReason
              : setup.trainingParent
                ? "This draft retains a training checkpoint. Evaluate the trained version from its result."
                : undefined,
          },
          {
            value: "sft",
            label: "SFT + LoRA",
            disabled:
              learnedSource || decision || engram || steering || Boolean(setup.trainingParent),
            description: steering
              ? steeringReason
              : setup.trainingParent
                ? "The current SFT worker starts from a pinned base; checkpoint continuation is unavailable."
                : undefined,
          },
          {
            value: "grpo",
            label: "RL (GRPO) + LoRA",
            disabled: learnedSource || decision || engram || steering,
            description: steering ? steeringReason : undefined,
          },
          {
            value: "neuron_steering",
            label: "Neuron steering",
            disabled: learnedSource || decision || engram || Boolean(setup.trainingParent),
            description: setup.trainingParent
              ? "The selected trained checkpoint has no qualified steering runtime."
              : "Compile and review a bounded hosted execution; a qualified runtime is required.",
          },
          {
            value: "engram_adapter",
            label: "Engram adapter",
            disabled:
              learnedSource ||
              decision ||
              steering ||
              setup.startingModel?.source === "trained" ||
              Boolean(setup.trainingParent),
            description: steering
              ? steeringReason
              : "Train a memory adapter from an exact qualified managed base and a reviewed supervised batch.",
          },
          {
            value: "inspect_activations",
            label: "Inspect activations",
            disabled:
              learnedSource || decision || engram || steering || Boolean(setup.trainingParent),
            description: steering
              ? steeringReason
              : setup.trainingParent
                ? "The selected trained checkpoint has no qualified inspection runtime."
                : "Compile and review a bounded hosted execution; a qualified runtime is required.",
          },
        ].filter((item) =>
          setup.allowedOperationTypes.includes(item.value as ExperimentOperationType),
        )}
        onChange={(value) => setup.setOperationType(value as ExperimentOperationType)}
      />
    </label>
  );
}
