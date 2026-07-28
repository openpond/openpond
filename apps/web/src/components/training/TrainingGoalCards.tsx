import {
  Boxes,
  CheckCircle2,
  MessageSquare,
  Search,
  SquarePen,
} from "../icons";

export type DatasetEvidenceIntent =
  | "demonstrations"
  | "preferences"
  | "verifiable_reward"
  | "rubric"
  | "discovery";

const TRAINING_GOALS = [
  {
    id: "demonstrations",
    title: "Teach with examples",
    description:
      "Provide prompts and approved responses that show the behavior you want.",
    example: "Example: “Answer in our support style.”",
    category: "Supervised learning",
    methods: ["SFT recommended"],
    icon: MessageSquare,
  },
  {
    id: "preferences",
    title: "Compare responses",
    description:
      "Choose which response is better for the same prompt, and why.",
    example: "Example: “Make this response more likely than that one.”",
    category: "Preference optimization",
    methods: ["DPO recommended"],
    icon: SquarePen,
  },
  {
    id: "verifiable_reward",
    title: "Reward correct outcomes",
    description: "Define an executable check that scores sampled responses.",
    example:
      "Example: +1 query executes; +1 returns expected rows; 0 otherwise.",
    category: "RLVR · verifiable rewards",
    methods: ["GRPO recommended", "PPO compatible"],
    icon: CheckCircle2,
  },
  {
    id: "rubric",
    title: "Score with a rubric",
    description:
      "Define review criteria with positive, negative, and boundary examples.",
    example: "Example: accurate, complete, grounded, and concise.",
    category: "Evaluation first",
    methods: ["DPO compatible", "PPO compatible"],
    icon: Boxes,
  },
  {
    id: "discovery",
    title: "Find opportunities",
    description:
      "Search an explicitly reviewed local chat scope for recurring work, then choose the evidence to build.",
    example: "OpenPond shows the eligible scope before any scan starts.",
    category: "Evidence discovery",
    methods: ["Method recommended after discovery"],
    icon: Search,
  },
] as const;

export function TrainingGoalCards({
  value,
  onChange,
  onActivate,
  ariaLabel = "What do you want to build?",
}: {
  value: DatasetEvidenceIntent | null;
  onChange: (intent: DatasetEvidenceIntent) => void;
  onActivate?: () => void;
  ariaLabel?: string;
}) {
  return (
    <div
      aria-label={ariaLabel}
      className="training-method-options training-start-mode-options training-evidence-intent-options"
      role="radiogroup"
    >
      {TRAINING_GOALS.map((goal) => {
        const Icon = goal.icon;
        const selected = goal.id === value;
        return (
          <button
            aria-checked={selected}
            data-intent={goal.id}
            className={selected ? "selected" : ""}
            key={goal.id}
            role="radio"
            type="button"
            onClick={() => onChange(goal.id)}
            onDoubleClick={onActivate}
            onKeyDown={(event) => {
              if (
                !["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(
                  event.key
                )
              ) {
                return;
              }
              event.preventDefault();
              const direction =
                event.key === "ArrowDown" || event.key === "ArrowRight"
                  ? 1
                  : -1;
              const currentIndex = TRAINING_GOALS.findIndex(
                (candidate) => candidate.id === goal.id
              );
              const nextIndex =
                (currentIndex + direction + TRAINING_GOALS.length) %
                TRAINING_GOALS.length;
              const next = TRAINING_GOALS[nextIndex]!;
              onChange(next.id);
              const buttons =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="radio"]'
                );
              buttons?.[nextIndex]?.focus();
            }}
          >
            <span className="training-start-mode-icon" aria-hidden="true">
              <Icon size={18} />
            </span>
            <span className="training-start-mode-copy">
              <strong>{goal.title}</strong>
              <small>{goal.description}</small>
              <small className="training-evidence-intent-example">
                {goal.example}
              </small>
              <span className="training-goal-method-pills">
                <span className="training-goal-category-pill">
                  {goal.category}
                </span>
                {goal.methods.map((method) => (
                  <span className="training-goal-method-pill" key={method}>
                    {method}
                  </span>
                ))}
              </span>
            </span>
            <span className="training-choice-indicator" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
