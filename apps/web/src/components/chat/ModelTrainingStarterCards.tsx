import GraduationCap from "lucide-react/dist/esm/icons/graduation-cap.js";
import Network from "lucide-react/dist/esm/icons/network.js";
import Route from "lucide-react/dist/esm/icons/route.js";
import Braces from "lucide-react/dist/esm/icons/braces.js";
import type { ComposerDraftStore } from "../../lib/composer-draft-store";
import { newResourceSetup, selectModelSetupMethod } from "../../lib/resource-setup-prompt";
import "./model-training-starter-cards.css";

const starters = [
  {
    id: "sft",
    title: "Train a model with SFT",
    description: "Learn math reasoning with GSM8K.",
    icon: GraduationCap,
    method: "SFT",
  },
  {
    id: "grpo",
    title: "Train a model with RL",
    description: "Learn from rewards with GRPO.",
    icon: Network,
    method: "GRPO",
  },
  {
    id: "decision",
    title: "Train a Decision Model",
    description: "Learn to choose between options.",
    icon: Route,
    method: "Decision",
  },
  {
    id: "weight-space",
    title: "Weight-space programming",
    description: "Edit model weights with a program.",
    icon: Braces,
    method: "Weight-space programming",
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
      {starters.map(({ id, title, description, icon: Icon, method }) => (
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
            draftStore.setResourceSetup(scopeKey, current =>
              selectModelSetupMethod(current?.kind === "model" ? current : newResourceSetup("model"), method));
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
    </section>
  );
}
