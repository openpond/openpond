import { ArrowUpRight, Reply, Trash2 } from "../icons";
import { composerSteerPreview } from "./composer-steer-queue";

export function ComposerSteerRow({
  prompt,
  sending = false,
  disabled = false,
  actionLabel = "Steer",
  actionDisabledReason,
  onSend,
  onDelete,
  onEdit,
}: {
  prompt: string;
  sending?: boolean;
  disabled?: boolean;
  actionLabel?: string;
  actionDisabledReason?: string;
  onSend(): void;
  onDelete(): void;
  onEdit(): void;
}) {
  return (
    <div className={`composer-steer-row ${sending ? "sending" : ""}`}>
      <span className="composer-steer-row-icon" aria-hidden="true">
        <Reply size={13} />
      </span>
      <span className="composer-steer-row-text" title={prompt}>
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
