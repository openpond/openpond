import GraduationCap from "lucide-react/dist/esm/icons/graduation-cap.js";
import Network from "lucide-react/dist/esm/icons/network.js";
import Route from "lucide-react/dist/esm/icons/route.js";
import Braces from "lucide-react/dist/esm/icons/braces.js";
import type { ComposerDraftStore } from "../../lib/composer-draft-store";
import "./model-training-starter-cards.css";

const starters = [
  {
    id: "sft",
    title: "Train a model with SFT",
    description: "Learn from reviewed examples.",
    icon: GraduationCap,
    prompt:
      "Help me prepare SFT training with LoRA using my selected resources. Resolve the exact supported starting model, reviewed demonstrations and separate evaluation setup. Show the effective configuration and estimated cost, and ask for any missing objective, data or spending limit before starting training. Keep the answering model and training target separate. Do not enable a recurring policy.",
  },
  {
    id: "grpo",
    title: "Train a model with RL",
    description: "Learn from rewards with GRPO.",
    icon: Network,
    prompt:
      "Help me prepare reinforcement learning with GRPO using my selected resources. Resolve the exact supported model, training tasks, reward graders and separate evaluation setup. Preserve an exact compatible parent if I have selected one; do not invent continuation support. Show the effective configuration and estimated cost, and ask for missing inputs or spending limits before starting training. Do not enable a recurring policy.",
  },
  {
    id: "decision",
    title: "Train a Decision Model",
    description: "Learn to choose between options.",
    icon: Route,
    prompt:
      "Help me prepare the supported Decision Model training workflow using my selected resources. Review the decision targets, data, exact supported backbone and evaluation setup. Show the effective configuration and estimated cost, and ask for missing inputs or spending limits before starting training. Use the dedicated Decision training operation, and do not enable a recurring policy.",
  },
] as const;

/** Synchronous draft insertion uses the current scoped store; it never submits a turn. */
export function ModelTrainingStarterCards({
  draftStore,
  scopeKey,
  submissionScopeKey,
  getCurrentSubmissionScopeKey,
  disabled,
  onFocus,
}: {
  draftStore: ComposerDraftStore;
  scopeKey: string;
  submissionScopeKey: string;
  getCurrentSubmissionScopeKey(): string;
  disabled?: boolean;
  onFocus(): void;
}) {
  return (
    <section
      className="model-training-starters"
      aria-label="Start model training"
    >
      {starters.map(({ id, title, description, icon: Icon, prompt }) => (
        <button
          key={id}
          type="button"
          className="model-training-starter"
          disabled={disabled}
          onClick={() => {
            if (
              disabled ||
              draftStore.getScopeKey() !== scopeKey ||
              getCurrentSubmissionScopeKey() !== submissionScopeKey
            )
              return;
            draftStore.setForScope(scopeKey, (current) =>
              current.includes(prompt)
                ? current
                : current.trim()
                  ? `${current}\n\n${prompt}`
                  : prompt,
            );
            onFocus();
          }}
        >
          <Icon size={18} aria-hidden />
          <span className="model-training-starter-title">{title}</span>
          <span className="model-training-starter-description">
            {description}
          </span>
        </button>
      ))}
      <button type="button" className="model-training-starter" disabled>
        <Braces size={18} aria-hidden />
        <span className="model-training-starter-title">
          Weight-space programming
        </span>
        <span className="model-training-starter-description">
          Not available yet.
        </span>
      </button>
    </section>
  );
}
