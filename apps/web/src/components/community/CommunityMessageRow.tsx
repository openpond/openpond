import type { CommunityMember, CommunityMessage } from "@openpond/contracts";
import { useState } from "react";
import { MarkdownText } from "../chat/MarkdownText";
import { Reply, SquarePen, Trash2 } from "../icons";

export function CommunityMessageRow(props: {
  message: CommunityMessage;
  author: CommunityMember | null;
  own: boolean;
  attachmentsAccessible: boolean;
  messagesById: ReadonlyMap<string, CommunityMessage>;
  membersById: ReadonlyMap<string, CommunityMember>;
  onReply: (message: CommunityMessage) => void;
  onEdit: (messageId: string, body: string) => Promise<boolean>;
  onDelete: (messageId: string) => Promise<boolean>;
  onDownloadAttachment: (attachmentId: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.message.body);
  const reply = props.message.refs.find((ref) => ref.refType === "message_reply");
  const replyMessage = reply ? props.messagesById.get(reply.refId) ?? null : null;
  const replyAuthor = replyMessage?.authorUserId ? props.membersById.get(replyMessage.authorUserId) ?? null : null;
  return (
    <article className={`community-message${props.own ? " own" : ""}`} id={`community-message-${props.message.id}`}>
      <div className="community-avatar">{initials(props.author?.name ?? props.author?.handle ?? "?")}</div>
      <div className="community-message-content">
        <header>
          <strong>{props.author?.name ?? props.author?.handle ?? "Community member"}</strong>
          <time dateTime={props.message.createdAt}>{messageTime(props.message.createdAt)}</time>
          {props.message.editedAt ? <span>edited</span> : null}
          {!props.message.deletedAt ? (
            <div className="community-message-actions">
              <button type="button" aria-label="Reply" onClick={() => props.onReply(props.message)}><Reply size={13} /></button>
              {props.own ? <button type="button" aria-label="Edit" onClick={() => setEditing(true)}><SquarePen size={13} /></button> : null}
              {props.own ? <button type="button" aria-label="Delete" onClick={() => void props.onDelete(props.message.id)}><Trash2 size={13} /></button> : null}
            </div>
          ) : null}
        </header>
        {reply ? (
          <button
            type="button"
            className="community-reply-quote"
            onClick={() => document.getElementById(`community-message-${reply.refId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
          >
            <strong>{replyAuthor?.name ?? "Community member"}</strong>
            <span>{replyMessage?.deletedAt ? "Message deleted" : replyMessage?.body ?? String(reply.preview.body ?? "Earlier message")}</span>
          </button>
        ) : null}
        {editing ? (
          <form className="community-message-edit" onSubmit={(event) => {
            event.preventDefault();
            void props.onEdit(props.message.id, draft).then((saved) => { if (saved) setEditing(false); });
          }}>
            <textarea autoFocus value={draft} onChange={(event) => setDraft(event.currentTarget.value)} />
            <div><button type="button" onClick={() => setEditing(false)}>Cancel</button><button type="submit" disabled={!draft.trim()}>Save</button></div>
          </form>
        ) : props.message.deletedAt ? (
          <div className="community-message-deleted">Message deleted</div>
        ) : (
          <MarkdownText content={props.message.body} />
        )}
        {!props.message.deletedAt && props.message.attachments.length > 0 ? (
          <div className="community-message-attachments">
            {props.message.attachments.map((attachment) => (
              props.attachmentsAccessible ? (
                <button type="button" key={attachment.id} onClick={() => void props.onDownloadAttachment(attachment.id)}>
                  <span>{attachment.name}</span><small>{formatBytes(attachment.sizeBytes)}</small>
                </button>
              ) : (
                <div className="community-attachment-placeholder" key={attachment.id}>
                  <span>{attachment.name}</span><small>Join to view · {formatBytes(attachment.sizeBytes)}</small>
                </div>
              )
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function initials(value: string): string {
  return value.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function messageTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
