import { useState } from "react";
import type { ChatAttachmentSummary } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { useChatAttachmentImageUrl } from "../../hooks/useChatAttachmentImageUrl";
import { ImageIcon } from "../icons";
import {
  AttachmentTypeIcon,
  formatAttachmentLineCount,
} from "./AttachmentTypeIcon";

export function MessageAttachments({
  attachments,
  compact,
  connection,
  onOpenAttachment,
}: {
  attachments: ChatAttachmentSummary[];
  compact: boolean;
  connection: ClientConnection | null;
  onOpenAttachment?: (attachment: ChatAttachmentSummary) => Promise<void>;
}) {
  return (
    <div
      className={`user-message-attachments${compact ? " compact" : ""}`}
      aria-label="Attached files"
    >
      {attachments.map((attachment) => (
        <MessageAttachment
          attachment={attachment}
          connection={connection}
          key={attachment.id}
          onOpenAttachment={onOpenAttachment}
        />
      ))}
    </div>
  );
}

function MessageAttachment({
  attachment,
  connection,
  onOpenAttachment,
}: {
  attachment: ChatAttachmentSummary;
  connection: ClientConnection | null;
  onOpenAttachment?: (attachment: ChatAttachmentSummary) => Promise<void>;
}) {
  if (attachment.kind === "image" && attachment.imagePreview) {
    return (
      <MessageImageAttachment
        attachment={attachment}
        connection={connection}
        onOpenAttachment={onOpenAttachment}
      />
    );
  }

  return (
    <MessageFileAttachment
      attachment={attachment}
      onOpenAttachment={onOpenAttachment}
    />
  );
}

function MessageFileAttachment({
  attachment,
  onOpenAttachment,
}: {
  attachment: ChatAttachmentSummary;
  onOpenAttachment?: (attachment: ChatAttachmentSummary) => Promise<void>;
}) {
  const [opening, setOpening] = useState(false);
  const canOpen = Boolean(
    (attachment.filePreview || attachment.imagePreview) && onOpenAttachment,
  );
  const detail = opening
    ? "Opening"
    : attachment.lineCount !== undefined
      ? formatAttachmentLineCount(attachment.lineCount)
      : null;
  const content = (
    <>
      <AttachmentTypeIcon attachment={attachment} size={13} />
      <span>{attachment.name}</span>
      {detail ? <small>{detail}</small> : null}
    </>
  );
  if (!canOpen) {
    return (
      <span className="user-message-attachment" title={attachment.name}>
        {content}
      </span>
    );
  }
  return (
    <button
      aria-label={`Open attached file ${attachment.name}`}
      className="user-message-attachment openable"
      disabled={opening}
      title={`Open ${attachment.name}`}
      type="button"
      onClick={() => {
        if (!onOpenAttachment || opening) return;
        setOpening(true);
        void onOpenAttachment(attachment).finally(() => setOpening(false));
      }}
    >
      {content}
    </button>
  );
}

function MessageImageAttachment({
  attachment,
  connection,
  onOpenAttachment,
}: {
  attachment: ChatAttachmentSummary;
  connection: ClientConnection | null;
  onOpenAttachment?: (attachment: ChatAttachmentSummary) => Promise<void>;
}) {
  const imageUrl = useChatAttachmentImageUrl(connection, attachment.imagePreview);
  const [opening, setOpening] = useState(false);

  return (
    <button
      className="user-message-image-attachment"
      aria-label={`Open attached image ${attachment.name}`}
      aria-busy={opening}
      disabled={!onOpenAttachment || opening}
      title={opening ? `Opening ${attachment.name}` : `Open ${attachment.name}`}
      type="button"
      onClick={() => {
        if (!onOpenAttachment || opening) return;
        setOpening(true);
        void onOpenAttachment(attachment).finally(() => setOpening(false));
      }}
    >
      {imageUrl ? (
        <img alt="" decoding="async" loading="lazy" src={imageUrl} />
      ) : (
        <ImageIcon size={24} />
      )}
    </button>
  );
}
