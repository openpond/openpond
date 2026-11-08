import "./composer-resources.css";
import { experimentOperationLabel } from "openpond-sdk/training";
import type { useChatContextSelection } from "../../hooks/useChatContextSelection";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { CHAT_CONTEXT_SELECTED } from "../../hooks/useChatContextSelection";

/** One evidence/status strip; editing and run controls live in the sidebar. */
export function ComposerResourceContext({ context, sessionId }: {
  context: ReturnType<typeof useChatContextSelection>;
  resources: ReturnType<typeof useChatResourceFocus>;
  sessionId: string | null;
  busy: boolean;
}) {
  const selected = context.selection;
  if (!selected) return null;
  const state = selected.training
    ? selected.training.location === "cloud" ? selected.training.job.state : selected.training.executionState
    : selected.model ? "Model" : selected.resource?.state ?? (selected.draft ? `Draft · ${experimentOperationLabel(selected.draft.operationType)}` : selected.detail);
  return <div className="composer-resource-area composer-resource-summary">
    <div className="composer-resource-bar" aria-label="Selected experiment or model run" aria-live="polite">
      <span className="composer-resource-dataset-name" title={selected.label}>{selected.label}</span>
      <span className="composer-resource-summary-state">{context.selecting ? "Loading…" : state}</span>
      <button type="button" className="composer-resource-secondary" disabled={context.selecting}
        onClick={() => window.dispatchEvent(new CustomEvent(CHAT_CONTEXT_SELECTED, {
          detail: { sessionId, scope: context.scope, targetKey: JSON.stringify(selected.target) },
        }))}>View</button>
    </div>
  </div>;
}
