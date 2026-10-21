import { ArrowUpRight, Reply, Trash2 } from "../icons";
import { composerSteerPreview } from "./composer-steer-queue";
import type { ChatAttachment } from "@openpond/contracts";
import { useMemo, useState } from "react";
import { AttachmentTypeIcon } from "./AttachmentTypeIcon";

type SteerAttachment = Pick<ChatAttachment, "name" | "kind" | "mediaType" | "contentsBase64">;

export function ComposerSteerRow({
  prompt,
  attachments = [],
  sending = false,
  disabled = false,
  actionLabel = "Steer",
  actionDisabledReason,
  onSend,
  onDelete,
  onEdit,
}: {
  prompt: string;
  attachments?: readonly SteerAttachment[];
  sending?: boolean;
  disabled?: boolean;
  actionLabel?: string;
  actionDisabledReason?: string;
  onSend(): void;
  onDelete(): void;
  onEdit(): void;
}) {
  const preview = attachments.find(file => file.kind === "image" && file.contentsBase64) ?? attachments[0];
  const attachmentNames = attachments.map(file => file.name).join(", ");
  return (
    <div className={`composer-steer-row ${sending ? "sending" : ""}`}>
      <span className="composer-steer-row-icon" aria-hidden={preview ? undefined : true}
        role={preview ? "img" : undefined} aria-label={preview ? `Attachments: ${attachmentNames}` : undefined}
        title={preview ? attachmentNames : undefined}>
        {preview ? <SteerAttachmentPreview attachment={preview} /> : <Reply size={13} />}
      </span>
      <span className="composer-steer-row-text" title={[prompt, ...attachments.map(file => file.name)].join("\n")}>
        {composerSteerPreview(prompt)}
      </span>
      <button
        type="button"
        className="composer-steer-row-action primary"
        disabled={disabled || sending || Boolean(actionDisabledReason)}
        title={actionDisabledReason}
        aria-label={`${actionLabel}: ${composerSteerPreview(prompt, 60)}${actionDisabledReason ? `. ${actionDisabledReason}` : ""}`}
        onClick={onSend}
      >
        <ArrowUpRight size={12} />
        <span>{sending ? "Sending" : actionLabel}</span>
      </button>
      <button
        type="button"
        className="composer-steer-row-icon-button"
        disabled={disabled || sending}
        data-tooltip="Delete queued message"
        aria-label="Delete queued message"
        onClick={onDelete}
      >
        <Trash2 size={13} />
      </button>
      <button
        type="button"
        className="composer-steer-row-action"
        disabled={disabled || sending}
        aria-label={`Edit: ${composerSteerPreview(prompt, 60)}`}
        onClick={onEdit}
      >
        <span>Edit</span>
      </button>
    </div>
  );
}

function SteerAttachmentPreview({ attachment }: { attachment: SteerAttachment }) {
  const { kind, mediaType, contentsBase64 } = attachment;
  const source = useMemo(() => kind === "image" && mediaType.startsWith("image/") && contentsBase64
    ? `data:${mediaType};base64,${contentsBase64}` : null, [kind, mediaType, contentsBase64]);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return source && source !== failedSource
    ? <img className="composer-steer-attachment-preview" src={source} alt="" width={13} height={13}
        loading="lazy" decoding="async" onError={() => setFailedSource(source)} />
    : <AttachmentTypeIcon attachment={attachment} size={13} />;
}
