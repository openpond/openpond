import { useId, useState, type ReactNode } from "react";
import type { ChatTimelineMessageRow, ChatTimelineRow } from "../../lib/chat-timeline-rows";
import { ChatActivitySummary } from "./ChatActivitySummary";
import { ThinkingIndicator } from "./Messages";

/** Final/steer rollups contain the original UI rows; provider events stay intact. */
export function ChatTimelineEntry({ row, renderMessage }: {
  row: ChatTimelineRow;
  renderMessage: (row: ChatTimelineMessageRow) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  if (row.type === "thinking") return <ThinkingIndicator />;
  if (row.type === "message") return renderMessage(row);
  return (
    <div className="chat-work-history">
      <ChatActivitySummary className="chat-work-history-summary" controls={detailsId}
        expanded={expanded} onToggle={() => setExpanded(value => !value)}>
        {row.label}
      </ChatActivitySummary>
      {expanded ? <div className="chat-work-history-content" id={detailsId}>
        {row.messages.map(message => <div key={message.id}>{renderMessage(message)}</div>)}
      </div> : null}
    </div>
  );
}
