import { hostedRecommendationSendBlocked, type PonderRecommendation } from "./ponder-recommendations";

export function PonderRecommendations({ items, busy, editingId, onEdit, onSend, onDismiss, onOpen }: {
  items: PonderRecommendation[]; busy: string | null; editingId: string | null;
  onEdit(item: PonderRecommendation): void; onSend(item: PonderRecommendation): void;
  onDismiss(item: PonderRecommendation): void; onOpen(conversationId: string): void;
}) {
  if (!items.length) return null;
  return <section className="ponder-recommendations" aria-label="Ponder recommendations">
    {items.map(item => <article key={item.id} className="ponder-recommendation" data-state={item.state}>
      <button type="button" className="ponder-recommendation-target" onClick={() => onOpen(item.target.conversationId)}>{item.target.title}</button>
      <p>{item.summary}</p>
      {item.submittedText || item.proposedText ? <blockquote>{item.submittedText ?? item.proposedText}</blockquote> : null}
      <details><summary>Why Ponder suggested this</summary>{item.evidence.map(evidence => <p key={evidence.id}>{evidence.excerpt}</p>)}</details>
      {["proposed", "failed", "stale", "submitting"].includes(item.state) ? <div className="ponder-recommendation-actions">
        {item.state === "proposed" && item.proposedText ? <><button type="button" disabled={Boolean(busy)} onClick={() => onEdit(item)}>{editingId === item.id ? "Editing below" : "Edit"}</button>
          <button type="button" disabled={Boolean(busy) || hostedRecommendationSendBlocked(item)} onClick={() => onSend(item)}>{busy === item.id ? "Sending…" : editingId === item.id ? "Send edited message" : "Send"}</button></> : null}
        {(item.state === "failed" || item.state === "submitting") && item.submittedText && item.submissionRevision !== null ? <button type="button" disabled={Boolean(busy)} onClick={() => onSend(item)}>{busy === item.id ? "Retrying…" : "Retry reviewed message"}</button> : null}
        {hostedRecommendationSendBlocked(item) ? <small role="status">Resolve this task's wait or cancellation before sending a new message.</small> : null}
        {item.state !== "submitting" ? <button type="button" disabled={Boolean(busy)} onClick={() => onDismiss(item)}>Dismiss</button> : <small role="status">Awaiting task acknowledgment</small>}
        {item.state === "stale" ? <small role="status">Task changed — review its latest state</small> : null}
      </div> : <small role="status">{item.state === "submitted" ? "Message submitted to the task" : item.state === "stale" ? "Task changed — review the latest task before sending" : item.state.replaceAll("_", " ")}</small>}
      {item.error ? <p role="alert">{item.error}</p> : null}
    </article>)}
  </section>;
}
