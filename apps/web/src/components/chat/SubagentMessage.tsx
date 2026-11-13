import { useId, useState } from "react";
import type { ClientConnection } from "../../api";
import type { ActivityItem } from "../../lib/app-models";
import { Bot, ChevronDown } from "../icons";
import { ChatActivitySummary } from "./ChatActivitySummary";
import { ConversationPeerLink } from "./ConversationPeerLink";
import { MarkdownText } from "./MarkdownText";
import { subagentRoleLabel } from "./SubagentAvatarGroup";

type SubagentMessageContext = {
  connection: ClientConnection | null;
  activeWorkspaceAppId: string | null;
  onOpenFileInSidebar?: (path: string) => void;
  onOpenSession?: (sessionId: string) => void;
};

export function SubagentMessageDetailRow({
  activity,
  ...context
}: SubagentMessageContext & { activity: ActivityItem }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const message = activity.subagentMessage;
  if (!message) return null;
  const roleLabel = subagentRoleLabel(message.roleId ?? activity.openSession?.roleId);
  const agentLabel =
    message.childTitle || (roleLabel === "Subagent" ? roleLabel : `${roleLabel} subagent`);
  const prefix = `${message.kind === "handoff" ? "Handoff" : "Message"} ${message.direction === "received" ? "from" : "to"}`;
  return (
    <div className="activity-tool-row task-message-row">
      <div className="task-message-summary-row">
        <ChatActivitySummary
          className="activity-tool-summary"
          icon={<Bot aria-hidden className="activity-summary-kind-icon" size={12} />}
        >
          <span>{prefix}</span>{" "}
          <ConversationPeerLink
            connection={context.connection}
            onOpenSession={context.onOpenSession}
            peer={{
              sessionId: message.childSessionId ?? activity.openSession?.sessionId ?? "",
              title: agentLabel,
              provider: message.modelRef?.providerId ?? "",
            }}
          />
        </ChatActivitySummary>
        <button
          type="button"
          className="activity-summary activity-tool-summary"
          aria-controls={bodyId}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} results: ${prefix} ${agentLabel}`}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDown
            aria-hidden
            className={`activity-summary-toggle ${expanded ? "expanded" : ""}`}
            size={14}
          />
        </button>
      </div>
      {expanded ? (
        <div className="assistant-message" id={bodyId}>
          <MarkdownText
            content={message.body}
            connection={context.connection}
            activeWorkspaceAppId={context.activeWorkspaceAppId}
            onOpenFileInSidebar={context.onOpenFileInSidebar}
            onOpenConversation={context.onOpenSession}
          />
        </div>
      ) : null}
    </div>
  );
}

export function SubagentMessageActivityGroup({
  activities,
  ...context
}: SubagentMessageContext & { activities: ActivityItem[] }) {
  return (
    <article className="activity-child-message-group">
      {activities.map((activity) => (
        <SubagentMessageDetailRow key={activity.id} activity={activity} {...context} />
      ))}
    </article>
  );
}
