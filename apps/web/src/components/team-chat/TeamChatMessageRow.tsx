import { useEffect, useRef, useState } from "react";
import type { TeamChatMember, TeamChatMessage } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import {
  teamChatReplyAuthorLabel,
  teamChatReplyTargetForMessage,
} from "../../lib/team-chat-reply";
import { Bot, MessageSquare, RefreshCw, Reply, SquarePen, Trash2, X } from "../icons";
import {
  TeamChatMessageReplyQuote,
  teamChatMessageDomId,
} from "./TeamChatReply";

export type TeamChatMessageRowProps = {
  message: TeamChatMessage;
  author: TeamChatMember | null;
  own: boolean;
  onOpenAiThread: (conversationId: string) => Promise<void>;
  onOpenAgentConversation: (agentRunId: string) => Promise<void>;
  onEdit: (message: TeamChatMessage, body: string) => Promise<boolean>;
  onDelete: (message: TeamChatMessage) => Promise<boolean>;
  onRetry: (message: TeamChatMessage) => Promise<boolean>;
  onDismissFailed: (message: TeamChatMessage) => void;
  membersById: ReadonlyMap<string, TeamChatMember>;
  messagesById: ReadonlyMap<string, TeamChatMessage>;
  onReply: (message: TeamChatMessage) => void;
  onOpenReplyMenu: (
    message: TeamChatMessage,
    input: {
      clientX: number;
      clientY: number;
      fallbackX: number;
      fallbackY: number;
    },
  ) => void;
  onJumpToMessage: (messageId: string) => void;
  connection: ClientConnection | null;
};

export function TeamChatMessageRow(props: TeamChatMessageRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.message.body);
  const aiRef = props.message.refs.find((ref) => ref.refType === "hosted_ai_thread");
  const agentRef = props.message.refs.find((ref) => ref.refType === "agent_run");
  const aiStatus = typeof aiRef?.preview.status === "string" ? aiRef.preview.status : null;
  const deliveryStatus =
    typeof props.message.metadata.deliveryStatus === "string"
      ? props.message.metadata.deliveryStatus
      : null;
  const uploadProgress =
    typeof props.message.metadata.uploadProgress === "string"
      ? props.message.metadata.uploadProgress
      : null;
  const canReply = !props.message.deletedAt && !deliveryStatus;
  const replyTarget = teamChatReplyTargetForMessage(props.message, props.messagesById);
  const replyAuthorLabel = replyTarget
    ? teamChatReplyAuthorLabel(replyTarget, props.membersById)
    : null;

  return (
    <article
      id={teamChatMessageDomId(props.message.id)}
      className={`team-chat-message${props.own ? " own" : ""}`}
      tabIndex={-1}
      onContextMenu={(event) => {
        if (!canReply) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        props.onOpenReplyMenu(props.message, {
          clientX: event.clientX,
          clientY: event.clientY,
          fallbackX: rect.right - 12,
          fallbackY: rect.top + 24,
        });
      }}
    >
      <TeamAvatar member={props.author} />
      <div className="team-chat-message-content">
        <header>
          <strong>{props.author?.name ?? "Team member"}</strong>
          <time>{messageTime(props.message.createdAt)}</time>
          {props.message.editedAt ? <span>edited</span> : null}
          {deliveryStatus === "sending" ? <span>sending</span> : null}
          {deliveryStatus === "sending" && uploadProgress ? (
            <span>uploaded {uploadProgress}</span>
          ) : null}
          {deliveryStatus === "failed" ? <span className="failed">not sent</span> : null}
          {deliveryStatus === "failed" ? (
            <div className="team-chat-message-actions visible">
              <button
                type="button"
                data-tooltip="Retry message"
                aria-label="Retry message"
                onClick={() => void props.onRetry(props.message)}
              >
                <RefreshCw size={13} />
              </button>
              <button
                type="button"
                data-tooltip="Remove failed message"
                aria-label="Remove failed message"
                onClick={() => props.onDismissFailed(props.message)}
              >
                <X size={13} />
              </button>
            </div>
          ) : canReply || (props.own && !props.message.deletedAt) ? (
            <div className="team-chat-message-actions">
              {canReply ? (
                <button
                  type="button"
                  data-tooltip="Reply"
                  aria-label="Reply to message"
                  onClick={() => props.onReply(props.message)}
                >
                  <Reply size={13} />
                </button>
              ) : null}
              {props.own && !aiRef ? (
                <button
                  type="button"
                  data-tooltip="Edit message"
                  aria-label="Edit message"
                  onClick={() => setEditing(true)}
                >
                  <SquarePen size={13} />
                </button>
              ) : null}
              {props.own ? (
                <button
                  type="button"
                  data-tooltip="Delete message"
                  aria-label="Delete message"
                  onClick={() => void props.onDelete(props.message)}
                >
                  <Trash2 size={13} />
                </button>
              ) : null}
            </div>
          ) : null}
        </header>
        {replyTarget && replyAuthorLabel ? (
          <TeamChatMessageReplyQuote
            authorLabel={replyAuthorLabel}
            target={replyTarget}
            onJump={() => props.onJumpToMessage(replyTarget.id)}
          />
        ) : null}
        {editing ? (
          <form
            className="team-chat-message-edit"
            onSubmit={(event) => {
              event.preventDefault();
              void props.onEdit(props.message, draft).then((saved) => {
                if (saved) setEditing(false);
              });
            }}
          >
            <textarea
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                setEditing(false);
                setDraft(props.message.body);
              }}
            />
            <div>
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button type="submit" disabled={!draft.trim()}>
                Save
              </button>
            </div>
          </form>
        ) : (
          <div className={props.message.deletedAt ? "deleted" : ""}>
            {props.message.deletedAt ? "Message deleted" : props.message.body}
          </div>
        )}
        {!props.message.deletedAt && props.message.attachments.length > 0 ? (
          <TeamChatMessageImages message={props.message} connection={props.connection} />
        ) : null}
        {aiRef ? (
          <button
            type="button"
            className="team-chat-thread-link"
            onClick={() => void props.onOpenAiThread(aiRef.refId)}
          >
            <MessageSquare size={14} />
            <span>Thread</span>
            {aiStatus && aiStatus !== "completed" ? (
              <small>{threadStatusLabel(aiStatus)}</small>
            ) : null}
            <span aria-hidden="true">›</span>
          </button>
        ) : null}
        {agentRef ? (
          <button
            type="button"
            className="team-chat-thread-link"
            onClick={() => void props.onOpenAgentConversation(agentRef.refId)}
          >
            <Bot size={14} />
            <span>Agent run</span>
            <small>{threadStatusLabel(String(agentRef.preview.status ?? "queued"))}</small>
            <span aria-hidden="true">›</span>
          </button>
        ) : null}
      </div>
    </article>
  );
}

function TeamChatMessageImages(props: {
  message: TeamChatMessage;
  connection: ClientConnection | null;
}) {
  const localPreviews = new Map(
    Array.isArray(props.message.metadata.localAttachmentPreviews)
      ? props.message.metadata.localAttachmentPreviews.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const candidate = value as { id?: unknown; url?: unknown };
          return typeof candidate.id === "string" && typeof candidate.url === "string"
            ? [[candidate.id, candidate.url] as const]
            : [];
        })
      : [],
  );

  return (
    <div className="team-chat-message-images">
      {props.message.attachments.map((attachment) => (
        <TeamChatMessageImage
          key={attachment.id}
          attachmentId={attachment.id}
          alt={attachment.name}
          teamId={props.message.teamId}
          connection={props.connection}
          localUrl={localPreviews.get(attachment.clientAttachmentId) ?? null}
        />
      ))}
    </div>
  );
}

function TeamChatMessageImage(props: {
  attachmentId: string;
  alt: string;
  teamId: string;
  connection: ClientConnection | null;
  localUrl: string | null;
}) {
  const [url, setUrl] = useState<string | null>(props.localUrl);
  const [failed, setFailed] = useState(false);
  const refreshCountRef = useRef(0);

  async function refreshUrl(): Promise<void> {
    if (!props.connection || props.localUrl) {
      if (!props.localUrl) setFailed(true);
      return;
    }
    setFailed(false);
    try {
      const result = await api.teamChatAttachmentDownload(
        props.connection,
        props.teamId,
        props.attachmentId,
      );
      setUrl(result.url);
    } catch {
      setUrl(null);
      setFailed(true);
    }
  }

  useEffect(() => {
    setUrl(props.localUrl);
    setFailed(false);
    refreshCountRef.current = 0;
    if (!props.localUrl) void refreshUrl();
    // The identifiers define the signed URL request; refreshUrl intentionally stays local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.attachmentId, props.connection, props.localUrl, props.teamId]);

  return url ? (
    <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${props.alt}`}>
      <img
        src={url}
        alt={props.alt}
        loading="lazy"
        onError={() => {
          if (!props.localUrl && refreshCountRef.current < 1) {
            refreshCountRef.current += 1;
            void refreshUrl();
            return;
          }
          setUrl(null);
          setFailed(true);
        }}
      />
    </a>
  ) : failed ? (
    <button
      type="button"
      className="team-chat-message-image-retry"
      aria-label={`Retry ${props.alt}`}
      data-tooltip="Retry image"
      onClick={() => {
        refreshCountRef.current = 0;
        if (props.localUrl) {
          setFailed(false);
          setUrl(props.localUrl);
        } else {
          void refreshUrl();
        }
      }}
    >
      <RefreshCw size={18} />
    </button>
  ) : (
    <div
      className="team-chat-message-image-loading"
      role="status"
      aria-label={`Loading ${props.alt}`}
    />
  );
}

function threadStatusLabel(status: string): string {
  if (status === "pending") return "Starting";
  if (status === "running") return "Responding";
  if (status === "failed") return "Failed";
  if (status === "interrupted") return "Interrupted";
  if (status === "cancelled") return "Cancelled";
  return status;
}

function TeamAvatar({ member }: { member: TeamChatMember | null }) {
  if (member?.image) {
    return <img className="team-chat-avatar" src={member.image} alt="" />;
  }
  const initials = (member?.name ?? "T")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return <span className="team-chat-avatar fallback">{initials}</span>;
}

function messageTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "";
}
