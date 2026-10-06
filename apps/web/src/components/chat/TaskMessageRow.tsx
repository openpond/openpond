import type { ChatMessage } from "../../lib/app-models";
import { MessageFooter } from "./MessageFooter";
import { MarkdownText } from "./MarkdownText";

/** Delivery state is transport evidence, never a claim of understanding/reply. */
export function TaskMessageRow({ message, onOpenSession }: {
  message: ChatMessage;
  onOpenSession?: (id: string) => void;
}) {
  const delivery = message.taskMessage;
  if (!delivery) return null;
  const { input, peer, direction } = delivery;
  const state = input.error ? input.error : {
    pending: "Queued", included: "Included in agent request", resolved: "Delivered to agent",
    rejected: "Not delivered", cancelled: "Cancelled",
  }[input.state];
  return <article className="message-row assistant task-message-row">
    <div className="task-message-body"><MarkdownText content={input.body} /></div>
    <div className="task-message-attribution">
      <span>{direction === "sent" ? "Sent to" : "Received from"}</span>
      {onOpenSession ? <button type="button" onClick={() => onOpenSession(peer.sessionId)}>{peer.title}</button> : <span>{peer.title}</span>}
      <span title={`Delivery receipt ${input.id}`} role="status">{state}</span>
    </div>
    <MessageFooter content={input.body} timestamp={message.timestamp} />
  </article>;
}
