import { ConversationPeerLink } from "./ConversationPeerLink";
import type { ChatMessage } from "../../lib/app-models";
import { ChatActivitySummary } from "./ChatActivitySummary";
import { Check, Loader2, CircleAlert, MessageSquare, ChevronDown, X } from "../icons";
import { useId, useState } from "react";
import { type ClientConnection } from "../../api/api-client";

/** Delivery state is transport evidence, never a claim of understanding/reply. */
export function TaskMessageRow({
  message,
  onOpenSession,
  onOpenPonder,
  connection,
}: {
  message: ChatMessage;
  onOpenSession?: (id: string) => void;
  onOpenPonder?: () => void;
  connection?: ClientConnection | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const delivery = message.taskMessage ?? message.taskMessagePresentation;
  if (!delivery) return null;
  const {input, direction, peer} = delivery;
  const state = input.error
    ? input.error
    : {
        pending: "Queued",
        included: "Included in agent request",
        resolved: "Delivered to agent",
        rejected: "Not delivered",
        cancelled: "Cancelled",
      }[input.state];
  const failed = input.state === "rejected";
  const delivered = input.state === "resolved";
  const StatusIcon = delivered ? Check : failed ? CircleAlert : input.state === "cancelled" ? X : Loader2;
  return (
    <article className="activity-tool-row task-message-row">
      <div className="task-message-summary-row">
        <ChatActivitySummary className="activity-tool-summary" danger={failed}
          icon={<MessageSquare aria-hidden className="activity-summary-kind-icon" size={12}/>}>
          <span>{direction === "sent" ? "Sent to" : "Received from"}</span>{" "}
          <ConversationPeerLink peer={peer} connection={connection} onOpenSession={onOpenSession} onOpenPonder={onOpenPonder}/>
          <span className="task-message-state" role="img" aria-label={state} title={state}>
            <StatusIcon aria-hidden size={12}/>
          </span>
        </ChatActivitySummary>
        <button type="button" className="activity-summary activity-tool-summary" aria-controls={detailsId}
          aria-expanded={expanded} aria-label={`${direction === "sent" ? "Sent to" : "Received from"} ${peer.title}: message details`}
          onClick={() => setExpanded(value => !value)}>
          <ChevronDown aria-hidden className={`activity-summary-toggle ${expanded ? "expanded" : ""}`} size={14}/>
        </button>
      </div>
      {expanded ? <div className="activity-tool-details" id={detailsId}>
        <pre className="activity-detail-output">{input.body}</pre>
      </div> : null}
    </article>
  );
}
