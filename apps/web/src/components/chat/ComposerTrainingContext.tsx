import type { useChatContextSelection } from "../../hooks/useChatContextSelection";
import { CHAT_CONTEXT_SELECTED } from "../../hooks/useChatContextSelection";
import "./composer-training-context.css";

/** The saved chat focus is also resolved from retained resources by the server. */
export function ComposerTrainingContext({ context, sessionId }: {
  context: ReturnType<typeof useChatContextSelection>;
  sessionId: string | null;
}) {
  const selected = context.selection;
  if (!selected) return null;
  const training = selected.training;
  const kind = training ? "Training run" : selected.model ? "Model" : selected.target.kind === "dataset" ? "Experiment draft" : "Experiment";
  const dataset = selected.dataset ?? (selected.resource?.kind === "dataset" ? selected.resource : null) ?? selected.model?.trainingDataset;
  const description = [
    dataset ? `${dataset.name} · revision ${dataset.revision}` : null,
    selected.graders?.length ? `${selected.graders.length} grader${selected.graders.length === 1 ? "" : "s"}` : null,
    training ? `Run ${training.jobId}` : null,
  ].filter(Boolean).join(" · ") || selected.detail;
  function open() {
    window.dispatchEvent(new CustomEvent(CHAT_CONTEXT_SELECTED, {
      detail: { sessionId, scope: context.scope, targetKey: JSON.stringify(selected!.target) },
    }));
  }
  return <section className="composer-training-context" aria-label="Selected training context">
    <div className="composer-training-context-copy">
      <span className="composer-training-context-kind">{kind}</span>
      <strong title={selected.label}>{selected.label}</strong>
      {training ? <span className="composer-training-context-kind">{training.location === "cloud" ? training.job.state === "succeeded" ? "Completed" : training.job.state : training.executionState}</span> : null}
      {description ? <span className="composer-training-context-detail" title={description}>{description}</span> : null}
    </div>
    <button type="button" onClick={open} aria-label={`Open ${kind.toLowerCase()} in sidebar`}>View</button>
  </section>;
}
