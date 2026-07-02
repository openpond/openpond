import { memo } from "react";
import { Copy, FileText, ImageIcon } from "../icons";
import type { ChatAttachmentSummary } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { useChatAttachmentImageUrl } from "../../hooks/useChatAttachmentImageUrl";
import type { ChatMessage } from "../../lib/app-models";
import { formatMessageTimestamp, formatMessageTimestampTitle } from "../../lib/chat-messages";
import { copyToClipboard } from "../../lib/clipboard";
import { MarkdownText } from "./MarkdownText";
import {
  ActionRunCard,
  isProfileActionRun,
  profileActionAgentLabel,
  profileActionFallbackText,
} from "./MessageActionRunCard";
import { ActivityGroup } from "./MessageActivityGroup";
import { ChangeSummaryCard } from "./MessageChangeSummary";
import { CreatePipelineStatusReceipt } from "./CreatePipelineStatusReceipt";
import { InsightsRunPromptCard } from "./MessageInsightsRunPrompt";

type MessageRowProps = {
  activeWorkspaceAppId?: string | null;
  connection?: ClientConnection | null;
  message: ChatMessage;
  onOpenBrowserLink?: (href: string, options?: { explicitFile?: boolean; newTab?: boolean }) => void;
  onOpenFileInSidebar?: (path: string) => void;
  onOpenProfileSettings?: () => void;
  showFooter?: boolean;
  workspaceRootPath?: string | null;
};

export const MessageRow = memo(function MessageRow({
  activeWorkspaceAppId = null,
  connection = null,
  message,
  onOpenBrowserLink,
  onOpenFileInSidebar,
  onOpenProfileSettings,
  showFooter = false,
  workspaceRootPath = null,
}: MessageRowProps) {
  if (message.role === "status_divider") {
    return <StatusDivider message={message} />;
  }

  if (message.role === "activity_group") {
    return <ActivityGroup activeWorkspaceAppId={activeWorkspaceAppId} connection={connection} message={message} />;
  }

  if (message.role === "error") {
    return (
      <article className="message-row assistant">
        <div className="assistant-message error-message">{message.content ?? ""}</div>
      </article>
    );
  }

  if (message.role === "user") {
    const hasAttachments = Boolean(message.attachments?.length);
    const hasImageAttachments = Boolean(message.attachments?.some((attachment) => attachment.kind === "image"));
    return (
      <article className="message-row user">
        <div className={`user-message ${message.insightsRunPrompt ? "insights-run-message" : ""} ${hasAttachments ? "has-attachments" : ""} ${hasImageAttachments ? "has-image-attachments" : ""}`}>
          {message.attachments?.length ? <MessageAttachments attachments={message.attachments} connection={connection} /> : null}
          {message.insightsRunPrompt ? <InsightsRunPromptCard prompt={message.insightsRunPrompt} /> : null}
          {message.content ? <div className="user-message-content">{message.content}</div> : null}
        </div>
      </article>
    );
  }

  const timestampLabel = formatMessageTimestamp(message.timestamp);
  const timestampTitle = formatMessageTimestampTitle(message.timestamp);
  const profileActionAgentName = message.actionRun && isProfileActionRun(message.actionRun)
    ? profileActionAgentLabel(message.actionRun)
    : null;

  return (
    <article className="message-row assistant">
      {message.content ? (
        <div className="assistant-message">
          <MarkdownText
            activeWorkspaceAppId={activeWorkspaceAppId}
            connection={connection}
            content={message.content}
            onOpenBrowserLink={onOpenBrowserLink}
            onOpenFileInSidebar={onOpenFileInSidebar}
            workspaceRootPath={workspaceRootPath}
          />
        </div>
      ) : null}
      {message.actionRun && isProfileActionRun(message.actionRun) ? (
        <div className={`assistant-message action-run-profile-message ${message.actionRun.status}`}>
          <MarkdownText
            activeWorkspaceAppId={activeWorkspaceAppId}
            connection={connection}
            content={message.actionRun.responseText ?? profileActionFallbackText(message.actionRun)}
            onOpenBrowserLink={onOpenBrowserLink}
            onOpenFileInSidebar={onOpenFileInSidebar}
            workspaceRootPath={workspaceRootPath}
          />
          {profileActionAgentName ? (
            <div className="action-run-agent-label">
              {onOpenProfileSettings ? (
                <button type="button" className="action-run-agent-link" onClick={onOpenProfileSettings}>
                  {profileActionAgentName}
                </button>
              ) : (
                <span>{profileActionAgentName}</span>
              )}
            </div>
          ) : null}
        </div>
      ) : message.actionRun ? (
        <ActionRunCard
          actionRun={message.actionRun}
          onOpenBrowserLink={onOpenBrowserLink}
          onOpenFileInSidebar={onOpenFileInSidebar}
        />
      ) : null}
      {message.changeSummary && (
        <ChangeSummaryCard
          summary={message.changeSummary}
          onOpenFileInSidebar={onOpenFileInSidebar}
        />
      )}
      {message.createPipelineRequest && (
        <CreatePipelineStatusReceipt
          request={message.createPipelineRequest}
          snapshot={message.createPipeline ?? null}
        />
      )}
      {showFooter && (
        <div className="assistant-message-footer">
          {timestampLabel && (
            <time className="message-timestamp" dateTime={message.timestamp} title={timestampTitle}>
              {timestampLabel}
            </time>
          )}
          <button
            type="button"
            className="message-copy-button"
            title="Copy message"
            aria-label="Copy assistant message"
            disabled={!message.content}
            onClick={() => {
              if (message.content) void copyToClipboard(message.content);
            }}
          >
            <Copy size={14} />
          </button>
        </div>
      )}
    </article>
  );
}, areMessageRowPropsEqual);

function areMessageRowPropsEqual(previous: MessageRowProps, next: MessageRowProps): boolean {
  return (
    previous.activeWorkspaceAppId === next.activeWorkspaceAppId &&
    previous.connection === next.connection &&
    previous.onOpenBrowserLink === next.onOpenBrowserLink &&
    previous.onOpenFileInSidebar === next.onOpenFileInSidebar &&
    previous.onOpenProfileSettings === next.onOpenProfileSettings &&
    previous.showFooter === next.showFooter &&
    previous.workspaceRootPath === next.workspaceRootPath &&
    chatMessageShallowEqual(previous.message, next.message)
  );
}

function chatMessageShallowEqual(previous: ChatMessage, next: ChatMessage): boolean {
  if (previous === next) return true;
  return (
    previous.id === next.id &&
    previous.role === next.role &&
    previous.content === next.content &&
    previous.timestamp === next.timestamp &&
    previous.turnId === next.turnId &&
    previous.statusKind === next.statusKind &&
    previous.statusState === next.statusState &&
    previous.statusTone === next.statusTone &&
    messageAttachmentsEqual(previous.attachments, next.attachments) &&
    previous.activities === next.activities &&
    previous.actionRun === next.actionRun &&
    previous.insightsRunPrompt === next.insightsRunPrompt &&
    previous.changeSummary === next.changeSummary &&
    previous.createPipelineRequest === next.createPipelineRequest &&
    previous.createPipeline === next.createPipeline &&
    previous.createPipelineDebugActivities === next.createPipelineDebugActivities
  );
}

function messageAttachmentsEqual(
  previous: ChatAttachmentSummary[] | undefined,
  next: ChatAttachmentSummary[] | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next || previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index]!;
    const right = next[index]!;
    if (
      left.id !== right.id ||
      left.kind !== right.kind ||
      left.name !== right.name ||
      left.mediaType !== right.mediaType ||
      left.sizeBytes !== right.sizeBytes ||
      left.imagePreview?.sessionId !== right.imagePreview?.sessionId ||
      left.imagePreview?.turnId !== right.imagePreview?.turnId ||
      left.imagePreview?.attachmentId !== right.imagePreview?.attachmentId ||
      left.imagePreview?.storageName !== right.imagePreview?.storageName ||
      left.imagePreview?.contentType !== right.imagePreview?.contentType
    ) {
      return false;
    }
  }
  return true;
}

function MessageAttachments({
  attachments,
  connection,
}: {
  attachments: ChatAttachmentSummary[];
  connection: ClientConnection | null;
}) {
  return (
    <div className="user-message-attachments" aria-label="Attached files">
      {attachments.map((attachment) => (
        <MessageAttachment attachment={attachment} connection={connection} key={attachment.id} />
      ))}
    </div>
  );
}

function MessageAttachment({
  attachment,
  connection,
}: {
  attachment: ChatAttachmentSummary;
  connection: ClientConnection | null;
}) {
  if (attachment.kind === "image" && attachment.imagePreview) {
    return <MessageImageAttachment attachment={attachment} connection={connection} />;
  }

  const Icon = attachment.kind === "image" ? ImageIcon : FileText;
  return (
    <span className="user-message-attachment" title={attachment.name}>
      <Icon size={13} />
      <span>{attachment.name}</span>
      <small>{formatBytes(attachment.sizeBytes)}</small>
    </span>
  );
}

function MessageImageAttachment({
  attachment,
  connection,
}: {
  attachment: ChatAttachmentSummary;
  connection: ClientConnection | null;
}) {
  const imageUrl = useChatAttachmentImageUrl(connection, attachment.imagePreview);

  return (
    <figure className={`user-message-image-attachment ${imageUrl ? "ready" : "loading"}`} title={attachment.name}>
      <div className="user-message-image-frame">
        {imageUrl ? (
          <img alt={attachment.name} decoding="async" loading="lazy" src={imageUrl} />
        ) : (
          <ImageIcon size={24} />
        )}
      </div>
      <figcaption>
        <span>{attachment.name}</span>
        <small>{formatBytes(attachment.sizeBytes)}</small>
      </figcaption>
    </figure>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let amount = value / 1024;
  for (const unit of units) {
    if (amount < 1024) return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
    amount /= 1024;
  }
  return `${amount.toFixed(0)} TB`;
}

export const ThinkingIndicator = memo(function ThinkingIndicator() {
  return (
    <article className="activity-group thinking-row" aria-live="polite">
      <div className="activity-summary thinking-summary" role="status">
        <span>Thinking...</span>
      </div>
    </article>
  );
});

function StatusDivider({ message }: { message: ChatMessage }) {
  const tone = message.statusTone ?? "info";
  const state = message.statusState ?? "idle";
  return (
    <article className={`status-divider ${tone} ${state}`} aria-live={tone === "danger" ? "assertive" : "polite"}>
      <span>{message.content ?? ""}</span>
    </article>
  );
}
