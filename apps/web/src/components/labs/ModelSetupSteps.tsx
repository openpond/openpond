export type ModelSetupStepId =
  | "dataset"
  | "method"
  | "configuration";

export type ModelSetupStep = {
  id: ModelSetupStepId;
  label: string;
  complete: boolean;
};

export const MODEL_SETUP_STEPS: Array<Pick<ModelSetupStep, "id" | "label">> = [
  { id: "dataset", label: "Taskset" },
  { id: "method", label: "Training method" },
  { id: "configuration", label: "Model and compute" },
];

export function ModelSetupSteps({
  activeStep,
  steps,
  onStepChange,
}: {
  activeStep: ModelSetupStepId;
  steps: ModelSetupStep[];
  onStepChange: (step: ModelSetupStepId) => void;
}) {
  return (
    <ol className="model-setup-step-list" aria-label="Run setup progress">
      {steps.map((step, index) => (
        <li
          className={[
            activeStep === step.id ? "active" : "",
            step.complete ? "complete" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          key={step.id}
        >
          <button
            aria-current={activeStep === step.id ? "step" : undefined}
            type="button"
            onClick={() => onStepChange(step.id)}
          >
            <span className="model-setup-step-label">
              {index + 1}. {step.label}
            </span>
            <span className="model-setup-step-segment" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ol>
  );
}
