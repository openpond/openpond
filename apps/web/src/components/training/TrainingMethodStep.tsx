import type { TaskCreationRequest } from "@openpond/contracts";
import { Activity, CheckCircle2, FileText, Lightbulb, type LucideIcon } from "../icons";

export type TrainingApproach = "recommend" | "sft" | "preference" | "rl";

const TRAINING_APPROACHES: Array<{
  id: TrainingApproach;
  title: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    id: "recommend",
    title: "Recommend for me",
    description: "Analyze the chats and choose the approach that fits the evidence.",
    icon: Lightbulb,
  },
  {
    id: "sft",
    title: "Supervised fine-tuning",
    description: "Learn from examples that already contain an approved answer.",
    icon: FileText,
  },
  {
    id: "preference",
    title: "Preference tuning",
    description: "Learn from preferred responses, corrections, or reviewer choices.",
    icon: CheckCircle2,
  },
  {
    id: "rl",
    title: "Reinforcement learning",
    description: "Optimize against a grader or another verifiable outcome.",
    icon: Activity,
  },
];

export function TrainingMethodStep({
  onCancel,
  onChange,
  onNext,
  value,
}: {
  onCancel: () => void;
  onChange: (value: TrainingApproach) => void;
  onNext: () => void;
  value: TrainingApproach;
}) {
  return (
    <>
      <div className="training-run-step-heading">
        <h3>Choose a training approach</h3>
        <p>You can choose one now or let the analysis model recommend it from your chats.</p>
      </div>
      <div className="training-method-options" role="radiogroup" aria-label="Training approach">
        {TRAINING_APPROACHES.map((option) => {
          const Icon = option.icon;
          const selected = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={selected ? "selected" : ""}
              onClick={() => onChange(option.id)}
            >
              <Icon size={17} />
              <span>
                <strong>{option.title}</strong>
                <small>{option.description}</small>
              </span>
            </button>
          );
        })}
      </div>
      <div className="training-dialog-actions">
        <button className="training-button secondary" type="button" onClick={onCancel}>Cancel</button>
        <button className="training-button" type="button" onClick={onNext}>Next</button>
      </div>
    </>
  );
}

export function methodHintForApproach(approach: TrainingApproach): TaskCreationRequest["methodHint"] {
  if (approach === "sft") return "sft";
  if (approach === "preference") return "dpo";
  if (approach === "rl") return "grpo";
  return null;
}

export function trainingApproachLabel(approach: TrainingApproach): string {
  if (approach === "sft") return "Supervised fine-tuning";
  if (approach === "preference") return "Preference tuning";
  if (approach === "rl") return "Reinforcement learning";
  return "Recommend for me";
}
