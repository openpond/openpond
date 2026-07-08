import { memo, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Copy, CreditCard, ExternalLink, FileText, Globe2, ImageIcon } from "../icons";
import type { ChatAttachmentSummary } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { useChatAttachmentImageUrl } from "../../hooks/useChatAttachmentImageUrl";
import type { ChatMessage, ChatSource } from "../../lib/app-models";
import { formatMessageTimestamp, formatMessageTimestampTitle } from "../../lib/chat-messages";
import { buildOpenPondBillingUrl } from "../../lib/cloud-environment-setup";
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
  accountBaseUrl?: string | null;
  billingOrganizationSlug?: string | null;
  billingTeamId?: string | null;
  connection?: ClientConnection | null;
  message: ChatMessage;
  onOpenBrowserLink?: (href: string, options?: { explicitFile?: boolean; newTab?: boolean }) => void;
  onOpenFileInSidebar?: (path: string) => void;
  onOpenProfileSettings?: () => void;
  onOpenSession?: (sessionId: string) => void;
  showFooter?: boolean;
  workspaceRootPath?: string | null;
};

export const MessageRow = memo(function MessageRow({
  activeWorkspaceAppId = null,
  accountBaseUrl = null,
  billingOrganizationSlug = null,
  billingTeamId = null,
  connection = null,
  message,
  onOpenBrowserLink,
  onOpenFileInSidebar,
  onOpenProfileSettings,
  onOpenSession,
  showFooter = false,
  workspaceRootPath = null,
}: MessageRowProps) {
  if (message.role === "status_divider") {
    return <StatusDivider message={message} />;
  }

  if (message.role === "activity_group") {
    return (
      <ActivityGroup
        activeWorkspaceAppId={activeWorkspaceAppId}
        connection={connection}
        message={message}
        onOpenSession={onOpenSession}
      />
    );
  }

  if (message.role === "reasoning") {
    return (
      <ReasoningMessage
        activeWorkspaceAppId={activeWorkspaceAppId}
        connection={connection}
        message={message}
        onOpenBrowserLink={onOpenBrowserLink}
        onOpenFileInSidebar={onOpenFileInSidebar}
        workspaceRootPath={workspaceRootPath}
      />
    );
  }

  if (message.role === "error") {
    if (message.errorKind === "opchat_quota_exceeded") {
      return (
        <article className="message-row assistant">
          <OpChatQuotaErrorCard
            accountBaseUrl={accountBaseUrl}
            billingOrganizationSlug={billingOrganizationSlug}
            billingTeamId={billingTeamId}
            onOpenBrowserLink={onOpenBrowserLink}
          />
        </article>
      );
    }
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
          {message.content ? <UserMessageContent content={message.content} /> : null}
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
      {message.sources?.length ? (
        <MessageSources sources={message.sources} onOpenBrowserLink={onOpenBrowserLink} />
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
          workspaceRootPath={workspaceRootPath}
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
          progressActivities={message.createPipelineDebugActivities}
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

const USER_MESSAGE_COLLAPSE_LINE_LIMIT = 10;

function UserMessageContent({ content }: { content: string }) {
  const lines = useMemo(() => content.split(/\r?\n/), [content]);
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = lines.length > USER_MESSAGE_COLLAPSE_LINE_LIMIT;
  const visibleContent = shouldCollapse && !expanded
    ? lines.slice(0, USER_MESSAGE_COLLAPSE_LINE_LIMIT).join("\n")
    : content;

  return (
    <div className={`user-message-content-wrap ${shouldCollapse ? "collapsible" : ""}`}>
      <div className="user-message-content">{visibleContent}</div>
      {shouldCollapse ? (
        <button
          type="button"
          className="user-message-show-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          <span>{expanded ? "Show less" : "Show more"}</span>
        </button>
      ) : null}
    </div>
  );
}

function areMessageRowPropsEqual(previous: MessageRowProps, next: MessageRowProps): boolean {
  return (
    previous.activeWorkspaceAppId === next.activeWorkspaceAppId &&
    previous.accountBaseUrl === next.accountBaseUrl &&
    previous.billingOrganizationSlug === next.billingOrganizationSlug &&
    previous.billingTeamId === next.billingTeamId &&
    previous.connection === next.connection &&
    previous.onOpenBrowserLink === next.onOpenBrowserLink &&
    previous.onOpenFileInSidebar === next.onOpenFileInSidebar &&
    previous.onOpenProfileSettings === next.onOpenProfileSettings &&
    previous.onOpenSession === next.onOpenSession &&
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
    previous.errorKind === next.errorKind &&
    messageAttachmentsEqual(previous.attachments, next.attachments) &&
    previous.activities === next.activities &&
    previous.sources === next.sources &&
    previous.actionRun === next.actionRun &&
    previous.insightsRunPrompt === next.insightsRunPrompt &&
    previous.changeSummary === next.changeSummary &&
    previous.createPipelineRequest === next.createPipelineRequest &&
    previous.createPipeline === next.createPipeline &&
    previous.createPipelineDebugActivities === next.createPipelineDebugActivities
  );
}

function MessageSources({
  sources,
  onOpenBrowserLink,
}: {
  sources: ChatSource[];
  onOpenBrowserLink?: (href: string, options?: { explicitFile?: boolean; newTab?: boolean }) => void;
}) {
  return (
    <div className="assistant-sources" aria-label="Sources">
      <span className="assistant-sources-label">
        <Globe2 size={13} />
        <span>Sources</span>
      </span>
      {sources.map((source) => (
        <SourcePill key={`${source.id}:${source.url}`} source={source} onOpenBrowserLink={onOpenBrowserLink} />
      ))}
    </div>
  );
}

function SourcePill({
  source,
  onOpenBrowserLink,
}: {
  source: ChatSource;
  onOpenBrowserLink?: (href: string, options?: { explicitFile?: boolean; newTab?: boolean }) => void;
}) {
  const label = sourceLabel(source);
  const title = [source.title, hostnameFromUrl(source.url)].filter(Boolean).join(" - ");
  const content = (
    <>
      <SourceFavicon source={source} />
      <span>{label}</span>
    </>
  );

  if (onOpenBrowserLink) {
    return (
      <button
        type="button"
        className="assistant-source-pill"
        title={title || label}
        aria-label={`Open source ${label}`}
        onClick={() => onOpenBrowserLink(source.url, { newTab: true })}
      >
        {content}
      </button>
    );
  }

  return (
    <a
      className="assistant-source-pill"
      href={source.url}
      target="_blank"
      rel="noreferrer"
      title={title || label}
      aria-label={`Open source ${label}`}
    >
      {content}
    </a>
  );
}

function SourceFavicon({ source }: { source: ChatSource }) {
  const [failed, setFailed] = useState(false);
  if (!source.faviconUrl || failed) {
    return <Globe2 className="assistant-source-fallback-icon" size={13} />;
  }
  return (
    <img
      alt=""
      aria-hidden="true"
      className="assistant-source-favicon"
      decoding="async"
      loading="lazy"
      src={source.faviconUrl}
      onError={() => setFailed(true)}
    />
  );
}

function sourceLabel(source: ChatSource): string {
  return source.sourceName?.trim() || hostnameFromUrl(source.url) || source.title;
}

function hostnameFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

function OpChatQuotaErrorCard({
  accountBaseUrl,
  billingOrganizationSlug,
  billingTeamId,
  onOpenBrowserLink,
}: {
  accountBaseUrl?: string | null;
  billingOrganizationSlug?: string | null;
  billingTeamId?: string | null;
  onOpenBrowserLink?: (href: string, options?: { explicitFile?: boolean; newTab?: boolean }) => void;
}) {
  const billingUrl = buildOpenPondBillingUrl({
    accountBaseUrl,
    organizationSlug: billingOrganizationSlug,
    teamId: billingTeamId,
  });
  const actionContent = (
    <>
      <CreditCard size={15} />
      <span>Add credits</span>
      <ExternalLink size={13} />
    </>
  );

  return (
    <div className="assistant-message quota-error-card" role="alert">
      <div className="quota-error-card-icon">
        <CreditCard size={17} />
      </div>
      <div className="quota-error-card-body">
        <strong>OpenPond Chat allowance reached</strong>
        <p>You have reached your OpChat token allowance for this period. Add credits or wait for the allowance to reset.</p>
        {onOpenBrowserLink ? (
          <button
            type="button"
            className="quota-error-card-action"
            onClick={() => onOpenBrowserLink(billingUrl, { newTab: true })}
          >
            {actionContent}
          </button>
        ) : (
          <a className="quota-error-card-action" href={billingUrl} target="_blank" rel="noreferrer">
            {actionContent}
          </a>
        )}
      </div>
    </div>
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

function ReasoningMessage({
  activeWorkspaceAppId,
  connection,
  message,
  onOpenBrowserLink,
  onOpenFileInSidebar,
  workspaceRootPath,
}: Pick<
  MessageRowProps,
  "activeWorkspaceAppId" | "connection" | "message" | "onOpenBrowserLink" | "onOpenFileInSidebar" | "workspaceRootPath"
>) {
  const content = message.content?.trim() ?? "";
  const [expanded, setExpanded] = useState(false);
  if (!content) return null;
  return (
    <article className="message-row assistant reasoning-row">
      <div className={`assistant-reasoning-message ${expanded ? "expanded" : "collapsed"}`}>
        <button
          type="button"
          className="assistant-reasoning-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          <span>{expanded ? "Hide thinking" : "Show thinking"}</span>
        </button>
        {expanded ? (
          <div className="assistant-reasoning-content">
            <MarkdownText
              activeWorkspaceAppId={activeWorkspaceAppId}
              connection={connection}
              content={content}
              onOpenBrowserLink={onOpenBrowserLink}
              onOpenFileInSidebar={onOpenFileInSidebar}
              workspaceRootPath={workspaceRootPath}
            />
          </div>
        ) : null}
      </div>
    </article>
  );
}

function StatusDivider({ message }: { message: ChatMessage }) {
  const tone = message.statusTone ?? "info";
  const state = message.statusState ?? "idle";
  return (
    <article className={`status-divider ${tone} ${state}`} aria-live={tone === "danger" ? "assertive" : "polite"}>
      <span>{message.content ?? ""}</span>
    </article>
  );
}
