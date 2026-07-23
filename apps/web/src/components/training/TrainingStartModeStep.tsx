import { Boxes, CheckCircle2, MessageSquare, Search, SquarePen } from "../icons";

export type NewModelMode = "automated" | "manual";
export type DatasetEvidenceIntent =
  | "demonstrations"
  | "preferences"
  | "verifiable_reward"
  | "rubric"
  | "discovery";
export type AgentSourceMode = "from_prompt" | "from_chats";
export type NewModelSetup =
  | DatasetEvidenceIntent
  | NewModelMode
  | AgentSourceMode
  | "existing_dataset";

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
  const isDatasetOrModel = targetLabel === "dataset" || targetLabel === "model";
  const copy = startModeCopy(targetLabel);
  const evidenceModes = [
    {
      id: "demonstrations" as const,
      title: "Teach with examples",
      description: "Provide prompts and approved responses that show the behavior you want.",
      example: "Example: “Answer in our support style.”",
      icon: MessageSquare,
    },
    {
      id: "preferences" as const,
      title: "Compare responses",
      description: "Choose which response is better for the same prompt, and why.",
      example: "Example: “Make this response more likely than that one.”",
      icon: SquarePen,
    },
    {
      id: "verifiable_reward" as const,
      title: "Reward correct outcomes",
      description: "Define an executable check that scores sampled responses.",
      example: "Example: +1 query executes; +1 returns expected rows; 0 otherwise.",
      icon: CheckCircle2,
    },
    {
      id: "rubric" as const,
      title: "Score with a rubric",
      description: "Define review criteria with positive, negative, and boundary examples.",
      example: "Example: accurate, complete, grounded, and concise.",
      icon: Boxes,
    },
  ];
  const existingDatasetMode = {
    id: "existing_dataset" as const,
    title: "Use existing Dataset",
    description: "Create the Model from a reviewed Dataset without changing its tasks, graders, or held-out Evals.",
    example: "Reuse one Dataset across multiple Models and training attempts.",
    icon: Boxes,
  };
  const legacyModes = [
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
  ];
  const discoveryMode = {
    id: "discovery" as const,
    title: "Find opportunities",
    description: "Search an explicitly reviewed local chat scope for recurring work, then choose the evidence to build.",
    example: "OpenPond shows the eligible scope before any scan starts.",
    icon: Search,
  };
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
    : isDatasetOrModel
      ? allowExistingDataset
        ? [existingDatasetMode, ...evidenceModes, discoveryMode]
        : [...evidenceModes, discoveryMode]
      : legacyModes;
  return (
    <>
      <div className="training-run-step-heading">
        <h3>{isAgent ? "Choose a setup" : "What do you want to build?"}</h3>
        <p>{copy.introduction}</p>
      </div>
      <div
        aria-label={isAgent
          ? `How to ${operation} an agent`
          : `How to start a new ${targetLabel}`}
        className={`training-method-options training-start-mode-options${isDatasetOrModel ? " training-evidence-intent-options" : ""}`}
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
              onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) return;
                event.preventDefault();
                const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
                const currentIndex = options.findIndex((candidate) => candidate.id === option.id);
                const nextIndex = (currentIndex + direction + options.length) % options.length;
                const next = options[nextIndex]!;
                onChange(next.id);
                const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
                buttons?.[nextIndex]?.focus();
              }}
            >
              <span className="training-start-mode-icon" aria-hidden="true">
                <Icon size={18} />
              </span>
              <span className="training-start-mode-copy">
                <strong>{option.title}</strong>
                <small>{option.description}</small>
                {"example" in option ? <small className="training-evidence-intent-example">{option.example}</small> : null}
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
      automaticDescription: "",
      introduction: "Start with the strongest evidence you can provide. OpenPond will recommend compatible training methods after the Dataset is built.",
      manualDescription: "",
    };
  }
  if (targetLabel === "model") {
    return {
      automaticDescription: "",
      introduction: "Use a reviewed Dataset or build the evidence first. Training method and destination come after Dataset readiness.",
      manualDescription: "",
    };
  }
  return {
    automaticDescription: `Choose chats to inspect for repeated work that could become a ${targetLabel}.`,
    introduction: `Let OpenPond find an opportunity in selected chats, or describe the ${targetLabel} you already want.`,
    manualDescription: `Describe the ${targetLabel}'s purpose yourself, with optional supporting chats.`,
  };
}
