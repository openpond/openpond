import { MessageSquare, SquarePen } from "../icons";
import {
  TrainingGoalCards,
  type DatasetEvidenceIntent,
} from "./TrainingGoalCards";

export type { DatasetEvidenceIntent } from "./TrainingGoalCards";

export type NewModelMode = "automated" | "manual";
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
  onUseExistingDataset,
}: {
  mode: NewModelSetup | null;
  allowExistingDataset?: boolean;
  operation?: "create" | "improve";
  targetLabel?: string;
  onChange: (mode: NewModelSetup) => void;
  onContinue: () => void;
  onUseExistingDataset?: () => void;
}) {
  const isAgent = targetLabel === "agent";
  const isDatasetOrModel = targetLabel === "dataset" || targetLabel === "model";
  const copy = startModeCopy(targetLabel);
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
  const options = isAgent ? agentModes : legacyModes;
  return (
    <>
      <div className="training-run-step-heading">
        <h3>{isAgent ? "Choose a setup" : "What do you want to build?"}</h3>
        <p>{copy.introduction}</p>
      </div>
      {isDatasetOrModel ? (
        <TrainingGoalCards
          ariaLabel={`How to start a new ${targetLabel}`}
          value={isDatasetEvidenceIntent(mode) ? mode : null}
          onActivate={onContinue}
          onChange={onChange}
        />
      ) : (
        <div
          aria-label={isAgent ? `How to ${operation} an agent` : `How to start a new ${targetLabel}`}
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
              </span>
              <span className="training-choice-indicator" aria-hidden="true" />
            </button>
          );
          })}
        </div>
      )}
      <div className="training-dialog-actions">
        {allowExistingDataset && onUseExistingDataset ? (
          <button
            className="training-button secondary"
            type="button"
            onClick={onUseExistingDataset}
          >
            Use existing Dataset
          </button>
        ) : null}
        <button className="training-button" type="button" disabled={!mode} onClick={onContinue}>Continue</button>
      </div>
    </>
  );
}

function isDatasetEvidenceIntent(value: NewModelSetup | null): value is DatasetEvidenceIntent {
  return (
    value === "demonstrations" ||
    value === "preferences" ||
    value === "verifiable_reward" ||
    value === "rubric" ||
    value === "discovery"
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
