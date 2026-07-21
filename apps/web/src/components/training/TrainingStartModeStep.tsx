import { Boxes, MessageSquare, SquarePen } from "../icons";

export type NewModelMode = "automated" | "manual";
export type AgentSourceMode = "from_prompt" | "from_chats";
export type NewModelSetup = NewModelMode | AgentSourceMode | "existing_dataset";

export function TrainingStartModeStep({
  mode,
  allowExistingDataset = false,
  operation = "create",
  targetLabel = "model",
  onChange,
  onContinue,
}: {
  mode: NewModelSetup | null;
  allowExistingDataset?: boolean;
  operation?: "create" | "improve";
  targetLabel?: string;
  onChange: (mode: NewModelSetup) => void;
  onContinue: () => void;
}) {
  const isAgent = targetLabel === "agent";
  const copy = startModeCopy(targetLabel);
  const modelModes = [
    {
      id: "automated" as const,
      title: "Automatic",
      description: copy.automaticDescription,
      icon: MessageSquare,
    },
    {
      id: "manual" as const,
      title: "Manual",
      description: copy.manualDescription,
      icon: SquarePen,
    },
    {
      id: "existing_dataset" as const,
      title: "Existing Dataset",
      description: "Create the Model from a reviewed Dataset without changing its tasks, graders, or held-out Evals.",
      icon: Boxes,
    },
  ];
  const agentModes = [
    {
      id: "from_prompt" as const,
      title: "From prompt",
      description: operation === "improve"
        ? "Describe the improvement you want without attaching chat evidence."
        : "Describe the Agent's purpose without attaching supporting chats.",
      icon: SquarePen,
    },
    {
      id: "from_chats" as const,
      title: "From chats",
      description: operation === "improve"
        ? "Describe the improvement and attach chats that show the correction or desired outcome."
        : "Describe the Agent's purpose and attach chats that show the work it should handle.",
      icon: MessageSquare,
    },
  ];
  const options = isAgent
    ? agentModes
    : allowExistingDataset
      ? modelModes
      : modelModes.filter((option) => option.id !== "existing_dataset");
  return (
    <>
      <div className="training-run-step-heading">
        <h3>Choose a setup</h3>
        <p>{copy.introduction}</p>
      </div>
      <div
        aria-label={isAgent
          ? `How to ${operation} an agent`
          : `How to start a new ${targetLabel}`}
        className="training-method-options training-start-mode-options"
        role="radiogroup"
      >
        {options.map((option) => {
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
              <span className="training-start-mode-icon" aria-hidden="true">
                <Icon size={18} />
              </span>
              <span className="training-start-mode-copy">
                <strong>{option.title}</strong>
                <small>{option.description}</small>
              </span>
              <span className="training-choice-indicator" aria-hidden="true" />
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

function startModeCopy(targetLabel: string): {
  automaticDescription: string;
  introduction: string;
  manualDescription: string;
} {
  if (targetLabel === "agent") {
    return {
      automaticDescription: "Choose chats that support the Agent's purpose.",
      introduction: "Describe what the Agent should do, with or without examples from your chats.",
      manualDescription: "Describe the Agent's purpose without supporting chats.",
    };
  }
  if (targetLabel === "dataset") {
    return {
      automaticDescription: "Choose chats to inspect for repeated work worth capturing in a Dataset.",
      introduction: "Let OpenPond find a Dataset opportunity in selected chats, or define the Dataset you already need.",
      manualDescription: "Define the Dataset's purpose yourself, with optional supporting chats.",
    };
  }
  if (targetLabel === "model") {
    return {
      automaticDescription: "Choose chats to inspect for repeated work that may be worth training into a Model.",
      introduction: "Let OpenPond find a training opportunity in selected chats, define the capability yourself, or start from an existing Dataset.",
      manualDescription: "Define the capability the Model should learn, with optional supporting chats.",
    };
  }
  return {
    automaticDescription: `Choose chats to inspect for repeated work that could become a ${targetLabel}.`,
    introduction: `Let OpenPond find an opportunity in selected chats, or describe the ${targetLabel} you already want.`,
    manualDescription: `Describe the ${targetLabel}'s purpose yourself, with optional supporting chats.`,
  };
}
