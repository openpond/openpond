import type { ClientConnection } from "../../api";
import type { ActivityItem } from "../../lib/app-models";
import { Bot } from "../icons";
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
  const message = activity.subagentMessage;
  if (!message) return null;
  const roleLabel = subagentRoleLabel(message.roleId ?? activity.openSession?.roleId);
  const agentLabel = roleLabel === "Subagent" ? roleLabel : `${roleLabel} subagent`;
  const title =
    message.direction === "received"
      ? agentLabel
      : `Message to ${agentLabel.toLowerCase()}`;
  return (
    <div className={`activity-child-message ${message.direction}`}>
      <div className="activity-child-message-card">
        <div className="activity-child-message-header">
          <span className="activity-child-message-title">
            <Bot aria-hidden size={14} />
            <strong>{title}</strong>
          </span>
          <small>{message.kind.replace(/_/g, " ")}</small>
        </div>
        <div className="assistant-message">
          <MarkdownText
            content={message.body}
            connection={context.connection}
            activeWorkspaceAppId={context.activeWorkspaceAppId}
            onOpenFileInSidebar={context.onOpenFileInSidebar}
            onOpenConversation={context.onOpenSession}
          />
        </div>
        <details className="activity-child-message-details">
          <summary>Message details</summary>
          <div className="activity-child-message-facts" aria-label="Child message metadata">
            {subagentMessageFacts(message).map((fact) => (
              <span key={fact.label}>
                <small>{fact.label}</small>
                <code title={fact.value}>{fact.value}</code>
              </span>
            ))}
          </div>
        </details>
        {message.refs?.length ? (
          <div className="activity-child-message-refs" aria-label="Child message references">
            {message.refs.map((ref) => (
              <span key={`${ref.kind}:${ref.id}`}>
                {ref.kind}:{ref.id} ({ref.label})
              </span>
            ))}
          </div>
        ) : null}
      </div>
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

function subagentMessageFacts(
  message: NonNullable<ActivityItem["subagentMessage"]>,
): Array<{ label: string; value: string }> {
  return [
    { label: "Message", value: message.messageId },
    { label: "Kind", value: message.kind },
    { label: "From", value: message.fromRunId },
    message.roleId ? { label: "Role", value: message.roleId } : null,
    message.modelRef
      ? {
          label: "Model",
          value: `${message.modelRef.providerId}/${message.modelRef.modelId}`,
        }
      : null,
    message.childSessionId ? { label: "Child", value: message.childSessionId } : null,
    message.toRunId ? { label: "To run", value: message.toRunId } : null,
    message.toRole ? { label: "To role", value: message.toRole } : null,
    message.deliveryStatus ? { label: "Delivery", value: message.deliveryStatus } : null,
    message.wakeReason ? { label: "Wake", value: message.wakeReason } : null,
    message.createdAt ? { label: "Created", value: message.createdAt } : null,
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact));
}
