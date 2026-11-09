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
      "Train a model with SFT and LoRA using my selected resources. Ask me for any missing objective, dataset or total budget. Show me the proposed run and estimated cost, then continue through training and evaluation within the agreed budget. Report the result and save the trained model if successful. Do not enable recurring training or serving.",
  },
  {
    id: "grpo",
    title: "Train a model with RL",
    description: "Learn from rewards with GRPO.",
    icon: Network,
    prompt:
      "Train a model with RL and GRPO using my selected resources. Ask me for any missing objective, dataset, reward grader or total budget. Show me the proposed run and estimated cost, then continue through training and evaluation within the agreed budget. Report the result and save the trained model if successful. Do not enable recurring training or serving.",
  },
  {
    id: "decision",
    title: "Train a Decision Model",
    description: "Learn to choose between options.",
    icon: Route,
    prompt:
      "Train a Decision Model using my selected resources. Ask me for any missing decision objective, dataset or total budget. Show me the proposed run and estimated cost, then continue through the supported Decision training and evaluation workflow within the agreed budget. Report the result and save the trained model if successful. Do not enable recurring training or serving.",
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
