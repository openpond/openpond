import { useState, type CSSProperties } from "react";
import {
  ChevronDown,
  CircleAlert,
  Bot,
  FileText,
  Globe2,
  ImageIcon,
  ListFilter,
  Lightbulb,
  Search,
  SquarePen,
  SquareTerminal,
  type LucideIcon,
} from "../icons";
import type { ClientConnection } from "../../api";
import { useLocalImageUrl } from "../../hooks/useLocalImageUrl";
import { useWorkspaceImageUrl } from "../../hooks/useWorkspaceImageUrl";
import type { ActivityItem, ChatMessage } from "../../lib/app-models";
import {
  summarizeActivityGroup,
  summarizeShellCommand,
  type ActivityGroupSummaryKind,
} from "../../lib/chat-activity-summary";
import { workspaceFileName } from "../../lib/workspace-images";
import { ImageLightbox } from "../common/ImageLightbox";

const COMMAND_OUTPUT_VISIBLE_LINES = 5;
const MAX_SUMMARY_SUBAGENT_AVATARS = 4;
const SUBAGENT_MESSAGE_VISIBLE_LINES = 5;
const SUBAGENT_MESSAGE_COLLAPSE_MIN_CHARS = 280;

type SubagentOpenSession = NonNullable<ActivityItem["openSession"]>;

export function ActivityGroup({
  activeWorkspaceAppId,
  connection,
  message,
  onOpenSession,
}: {
  activeWorkspaceAppId: string | null;
  connection: ClientConnection | null;
  message: ChatMessage;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openImage, setOpenImage] = useState<ActivityItem["imagePreview"] | null>(null);
  const activities = message.activities ?? [];
  const summary = summarizeActivityGroup(activities);
  const summaryImage = activities.find((activity) => activity.imagePreview)?.imagePreview ?? null;
  const openImageSrc = useActivityImageUrl(openImage, connection, activeWorkspaceAppId);
  const danger = activities.some((activity) => activity.controlKind === "turn_aborted");
  const summaryOpenSessions = subagentOpenSessions(activities);
  const childMessageSummary = activities.length > 0 && activities.every((activity) => activity.subagentMessage);

  if (childMessageSummary) {
    return (
      <SubagentMessageActivityGroup
        activities={activities}
      />
    );
  }

  return (
    <article className="activity-group">
      <div className="activity-summary-row">
        <button
          type="button"
          aria-expanded={expanded}
          className={`activity-summary ${danger ? "danger" : ""}`}
          onClick={() => setExpanded((current) => !current)}
        >
          {summaryImage ? (
            <ActivitySummaryImage activeWorkspaceAppId={activeWorkspaceAppId} connection={connection} image={summaryImage} />
          ) : (
            <ActivitySummaryIcon kind={summary.kind} />
          )}
          <ActivitySummaryText summary={summary.text} />
          <ChevronDown className={`activity-summary-toggle ${expanded ? "expanded" : ""}`} size={14} />
        </button>
        {summaryOpenSessions.length > 0 && onOpenSession ? (
          <SubagentAvatarGroup
            onOpenSession={onOpenSession}
            onShowAll={() => setExpanded(true)}
            sessions={summaryOpenSessions}
          />
        ) : null}
      </div>
      {expanded && (
        <div className="activity-details">
          {activities.map((activity) => (
            <ActivityDetailRow
              activeWorkspaceAppId={activeWorkspaceAppId}
              activity={activity}
              connection={connection}
              key={activity.id}
              onOpenImage={setOpenImage}
              onOpenSession={onOpenSession}
            />
          ))}
        </div>
      )}
      <ImageLightbox
        open={Boolean(openImageSrc)}
        src={openImageSrc}
        title={openImage?.path ?? ""}
        onClose={() => setOpenImage(null)}
      />
    </article>
  );
}

function ActivityDetailRow({
  activeWorkspaceAppId,
  activity,
  connection,
  onOpenImage,
  onOpenSession,
}: {
  activeWorkspaceAppId: string | null;
  activity: ActivityItem;
  connection: ClientConnection | null;
  onOpenImage: (image: ActivityItem["imagePreview"] | null) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const imageSrc = useActivityImageUrl(activity.imagePreview ?? null, connection, activeWorkspaceAppId);
  if (activity.subagentMessage) {
    return (
      <SubagentMessageDetailRow
        activity={activity}
      />
    );
  }
  return (
    <div
      className={`activity-detail-row ${activity.controlKind === "turn_aborted" ? "danger" : ""}`}
      key={activity.id}
    >
      <span>{activity.label}</span>
      <div className="activity-detail-main">
        {activity.content && (
          activity.kind === "command" ? (
            <ShellCommandCode className="activity-detail-command" command={activity.content} />
          ) : isMultilineActivity(activity.content) ? (
            <pre className="activity-detail-output">{activity.content}</pre>
          ) : (
            <code>{activity.content}</code>
          )
        )}
        {activity.detail && (
          <pre className="activity-detail-output">{compactActivityOutput(activity.detail)}</pre>
        )}
        {activity.meta && <small className="activity-detail-meta">{activity.meta}</small>}
        {activity.imagePreview && imageSrc && (
          <button
            type="button"
            className="activity-image-preview"
            title={`Open ${activity.imagePreview.path}`}
            onClick={() => onOpenImage(activity.imagePreview ?? null)}
          >
            <img
              alt={workspaceFileName(activity.imagePreview.path)}
              decoding="async"
              loading="lazy"
              src={imageSrc}
            />
          </button>
        )}
        {activity.openSession && onOpenSession ? (
          <SubagentAvatarButton
            className="activity-subagent-detail-avatar"
            openSession={activity.openSession}
            onOpenSession={onOpenSession}
          />
        ) : null}
      </div>
    </div>
  );
}

function SubagentMessageDetailRow({
  activity,
}: {
  activity: ActivityItem;
}) {
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const message = activity.subagentMessage;
  if (!message) return null;
  const roleLabel = `${subagentRoleLabel(message.roleId ?? activity.openSession?.roleId)} subagent`;
  const baseTitle = message.direction === "received" ? `${roleLabel} update` : `Message to ${roleLabel.toLowerCase()}`;
  const title = message.modelRef?.modelId ? `${baseTitle} · ${message.modelRef.modelId}` : baseTitle;
  const facts = subagentMessageFacts(message);
  const collapsible = subagentMessageNeedsCollapse(message.body);
  return (
    <div className={`activity-child-message ${message.direction}`} key={activity.id}>
      <div className="activity-child-message-card">
        <div className="activity-child-message-header">
          <span className="activity-child-message-title">
            <Bot aria-hidden size={14} />
            <strong title={title}>{title}</strong>
          </span>
          <small>{message.kind.replace(/_/g, " ")}</small>
        </div>
        <p
          className={collapsible && !bodyExpanded ? "collapsed" : undefined}
          style={{ "--subagent-message-visible-lines": SUBAGENT_MESSAGE_VISIBLE_LINES } as CSSProperties}
        >
          {message.body}
        </p>
        {collapsible ? (
          <button
            type="button"
            className="activity-child-message-toggle"
            aria-expanded={bodyExpanded}
            onClick={() => setBodyExpanded((current) => !current)}
          >
            {bodyExpanded ? "Show less" : "Show more"}
          </button>
        ) : null}
        <details className="activity-child-message-details">
          <summary>Message details</summary>
          <div className="activity-child-message-facts" aria-label="Child message metadata">
            {facts.map((fact) => (
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

function SubagentMessageActivityGroup({
  activities,
}: {
  activities: ActivityItem[];
}) {
  const direction = activities[0]?.subagentMessage?.direction ?? "received";
  return (
    <article className={`activity-child-message-group ${direction}`}>
      {activities.map((activity) => (
        <SubagentMessageDetailRow
          activity={activity}
          key={activity.id}
        />
      ))}
    </article>
  );
}

function subagentMessageFacts(message: NonNullable<ActivityItem["subagentMessage"]>): Array<{ label: string; value: string }> {
  return [
    { label: "Message", value: message.messageId },
    { label: "Kind", value: message.kind },
    { label: "From", value: message.fromRunId },
    message.roleId ? { label: "Role", value: message.roleId } : null,
    message.modelRef
      ? { label: "Model", value: `${message.modelRef.providerId}/${message.modelRef.modelId}` }
      : null,
    message.childSessionId ? { label: "Child", value: message.childSessionId } : null,
    message.parentGoalId ? { label: "Goal", value: message.parentGoalId } : null,
    message.toRunId ? { label: "To run", value: message.toRunId } : null,
    message.toRole ? { label: "To role", value: message.toRole } : null,
    message.deliveryStatus ? { label: "Delivery", value: message.deliveryStatus } : null,
    message.wakeReason ? { label: "Wake", value: message.wakeReason } : null,
    message.createdAt ? { label: "Created", value: message.createdAt } : null,
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact));
}

export function subagentMessageNeedsCollapse(body: string): boolean {
  return body.length > SUBAGENT_MESSAGE_COLLAPSE_MIN_CHARS || body.split(/\r?\n/).length > SUBAGENT_MESSAGE_VISIBLE_LINES;
}

function ActivitySummaryText({ summary }: { summary: string }) {
  return <span className="activity-summary-text">{summary}</span>;
}

function ShellCommandCode({ className, command }: { className: string; command: string }) {
  const display = summarizeShellCommand(command) ?? command;
  return (
    <code className={`${className} shell-command-code`} title={command}>
      {display === command ? highlightShellCommand(command) : display}
    </code>
  );
}

function highlightShellCommand(command: string) {
  return tokenizeShellCommand(command).map((token, index) => (
    <span className={`shell-token ${token.kind}`} key={`${index}-${token.text}`}>
      {token.text}
    </span>
  ));
}

function compactActivityOutput(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trimEnd();
  const lines = normalized.split("\n");
  if (lines.length <= COMMAND_OUTPUT_VISIBLE_LINES) return normalized;
  const omitted = lines.length - COMMAND_OUTPUT_VISIBLE_LINES;
  return `${lines.slice(0, COMMAND_OUTPUT_VISIBLE_LINES).join("\n")}\n... ${omitted} ${omitted === 1 ? "line" : "lines"} omitted`;
}

type ShellToken = {
  kind: "plain" | "command" | "flag" | "string" | "operator" | "variable" | "path";
  text: string;
};

function tokenizeShellCommand(command: string): ShellToken[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|&&|\|\||[|;&()<>]|\s+|[^\s|;&()<>]+/g) ?? [command];
  let expectsCommand = true;
  return tokens.map((text) => {
    if (/^\s+$/.test(text)) return { kind: "plain", text };
    if (/^(?:&&|\|\||[|;&()<>])$/.test(text)) {
      expectsCommand = text !== ")" && text !== ">";
      return { kind: "operator", text };
    }
    if (/^(['"]).*\1$/.test(text)) return { kind: "string", text };
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(text)) return { kind: "variable", text };
    if (expectsCommand) {
      expectsCommand = false;
      return { kind: "command", text };
    }
    if (/^-{1,2}[\w-]/.test(text)) return { kind: "flag", text };
    if (/^(?:\.{0,2}\/|~\/|[\w.-]+\/)/.test(text)) return { kind: "path", text };
    return { kind: "plain", text };
  });
}

function ActivitySummaryImage({
  activeWorkspaceAppId,
  connection,
  image,
}: {
  activeWorkspaceAppId: string | null;
  connection: ClientConnection | null;
  image: NonNullable<ActivityItem["imagePreview"]>;
}) {
  const src = useActivityImageUrl(image, connection, activeWorkspaceAppId);
  if (!src) return null;
  return <img aria-hidden className="activity-summary-image" decoding="async" loading="lazy" src={src} alt="" />;
}

function ActivitySummaryIcon({ kind }: { kind: ActivityGroupSummaryKind }) {
  const Icon = activitySummaryIcon(kind);
  return <Icon aria-hidden className={`activity-summary-kind-icon ${kind}`} size={14} />;
}

function activitySummaryIcon(kind: ActivityGroupSummaryKind): LucideIcon {
  if (kind === "approval" || kind === "control") return CircleAlert;
  if (kind === "edit") return SquarePen;
  if (kind === "image") return ImageIcon;
  if (kind === "list") return ListFilter;
  if (kind === "read") return FileText;
  if (kind === "reasoning") return Lightbulb;
  if (kind === "search") return Search;
  if (kind === "subagent") return Bot;
  if (kind === "web") return Globe2;
  return SquareTerminal;
}

function SubagentAvatarGroup({
  onOpenSession,
  onShowAll,
  sessions,
}: {
  onOpenSession: (sessionId: string) => void;
  onShowAll: () => void;
  sessions: SubagentOpenSession[];
}) {
  const visible = sessions.slice(0, MAX_SUMMARY_SUBAGENT_AVATARS);
  const hiddenCount = Math.max(0, sessions.length - visible.length);
  const label = sessions.map(subagentAvatarLabel).join(", ");
  return (
    <div
      aria-label={`Subagent conversations: ${label}`}
      className="activity-subagent-avatar-group"
      title={`Subagent conversations: ${label}`}
    >
      {visible.map((openSession) => (
        <SubagentAvatarButton
          key={openSession.sessionId}
          openSession={openSession}
          onOpenSession={onOpenSession}
        />
      ))}
      {hiddenCount > 0 ? (
        <button
          type="button"
          aria-label={`Show ${hiddenCount} more subagent conversation${hiddenCount === 1 ? "" : "s"}`}
          className="activity-subagent-avatar activity-subagent-avatar-count"
          onClick={onShowAll}
          title={`Show ${hiddenCount} more subagent conversation${hiddenCount === 1 ? "" : "s"}`}
        >
          +{hiddenCount}
        </button>
      ) : null}
    </div>
  );
}

function SubagentAvatarButton({
  className = "",
  onOpenSession,
  openSession,
}: {
  className?: string;
  onOpenSession: (sessionId: string) => void;
  openSession: SubagentOpenSession;
}) {
  const roleId = normalizedSubagentRole(openSession.roleId);
  const status = normalizedSubagentStatus(openSession.status);
  const label = `Open ${subagentAvatarLabel(openSession)} conversation`;
  return (
    <button
      type="button"
      aria-label={label}
      className={`activity-subagent-avatar ${className}`}
      data-role={roleId}
      data-status={status}
      onClick={() => onOpenSession(openSession.sessionId)}
      title={label}
    >
      <SubagentRoleGlyph roleId={roleId} />
    </button>
  );
}

function SubagentRoleGlyph({ roleId }: { roleId: string }) {
  if (roleId === "coding") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
        <path d="M9.4 7.2 4.8 12l4.6 4.8" />
        <path d="m14.6 7.2 4.6 4.8-4.6 4.8" />
        <path d="m12.9 5.7-1.8 12.6" />
      </svg>
    );
  }
  if (roleId === "research") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
        <circle cx="10.8" cy="10.8" r="5.2" />
        <path d="m15 15 4 4" />
        <path d="M8.6 10.8h4.4" />
        <path d="M10.8 8.6v4.4" />
      </svg>
    );
  }
  if (roleId === "review") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
        <path d="M7 4.8h7.2L18 8.6v10.6H7z" />
        <path d="M14 4.8v4h4" />
        <path d="m8.9 14.2 2 2 4.3-4.7" />
      </svg>
    );
  }
  if (roleId === "test") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
        <path d="M9.2 4.8h5.6" />
        <path d="M10.4 4.8v5.4l-4 6.8a1.8 1.8 0 0 0 1.6 2.7h8a1.8 1.8 0 0 0 1.6-2.7l-4-6.8V4.8" />
        <path d="M8.2 15.8h7.6" />
      </svg>
    );
  }
  if (roleId === "docs") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
        <path d="M7 4.8h7.2L18 8.6v10.6H7z" />
        <path d="M14 4.8v4h4" />
        <path d="M9.2 11.4h5.6" />
        <path d="M9.2 14.2h5.6" />
        <path d="M9.2 17h3.4" />
      </svg>
    );
  }
  if (roleId === "planner") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
        <circle cx="7.2" cy="7.2" r="2.1" />
        <circle cx="16.8" cy="7.2" r="2.1" />
        <circle cx="12" cy="16.8" r="2.1" />
        <path d="M9 8.2h6" />
        <path d="m8.5 9 2.4 5.4" />
        <path d="m15.5 9-2.4 5.4" />
      </svg>
    );
  }
  if (roleId === "summarizer") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
        <path d="M7 6.8h10" />
        <path d="M7 10.4h8.2" />
        <path d="M7 14h6.2" />
        <path d="M7 17.6h4.2" />
      </svg>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
      <circle cx="12" cy="8.2" r="3.2" />
      <path d="M6.5 19.2c.6-3 2.5-5 5.5-5s4.9 2 5.5 5" />
      <path d="M5.2 11.8h2" />
      <path d="M16.8 11.8h2" />
    </svg>
  );
}

function subagentOpenSessions(activities: ActivityItem[]): SubagentOpenSession[] {
  const bySession = new Map<string, SubagentOpenSession>();
  for (const activity of activities) {
    const openSession = activity.openSession;
    if (!openSession) continue;
    bySession.set(openSession.sessionId, {
      ...bySession.get(openSession.sessionId),
      ...openSession,
    });
  }
  return [...bySession.values()].reverse();
}

function subagentAvatarLabel(openSession: SubagentOpenSession): string {
  const role = `${subagentRoleLabel(openSession.roleId)} subagent`;
  const status = openSession.status?.replace(/_/g, " ").trim();
  return status ? `${role} (${status})` : role;
}

function subagentRoleLabel(roleId: string | undefined): string {
  const normalized = normalizedSubagentRole(roleId);
  return normalized
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ") || "Subagent";
}

function normalizedSubagentRole(roleId: string | undefined): string {
  const value = roleId?.trim().toLowerCase() || "subagent";
  return /^[a-z][a-z0-9_-]*$/.test(value) ? value : "subagent";
}

function normalizedSubagentStatus(status: string | undefined): string {
  const value = status?.trim().toLowerCase() || "unknown";
  return /^[a-z][a-z0-9_-]*$/.test(value) ? value : "unknown";
}

function useActivityImageUrl(
  image: ActivityItem["imagePreview"] | null,
  connection: ClientConnection | null,
  activeWorkspaceAppId: string | null,
): string | null {
  const localPath = image && isAbsoluteLocalImagePath(image.path) ? image.path : null;
  const appId = image?.appId ?? activeWorkspaceAppId;
  const localUrl = useLocalImageUrl(connection, localPath);
  const workspaceUrl = useWorkspaceImageUrl(connection, localPath ? null : appId, localPath ? null : image?.path);
  return localPath ? localUrl : workspaceUrl;
}

function isAbsoluteLocalImagePath(path: string): boolean {
  return /^file:\/\//i.test(path) || /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}

function isMultilineActivity(value: string): boolean {
  return value.includes("\n") || value.length > 160;
}
