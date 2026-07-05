import { ArrowUpRight, MoreHorizontal, SquarePen, Trash2 } from "../icons";
import {
  composerSteerPreview,
  type ComposerSteerDraft,
} from "./composer-steer-queue";

export function ComposerSteerQueue({
  drafts,
  editDraftValue,
  editingDraft,
  sendingDraftId,
  onCancelEdit,
  onDeleteDraft,
  onEditDraft,
  onEditDraftValueChange,
  onReplaceComposerDraft,
  onSaveQueuedDraft,
  onSteerDraft,
}: {
  drafts: ComposerSteerDraft[];
  editDraftValue: string;
  editingDraft: ComposerSteerDraft | null;
  sendingDraftId: string | null;
  onCancelEdit: () => void;
  onDeleteDraft: (draftId: string) => void;
  onEditDraft: (draft: ComposerSteerDraft) => void;
  onEditDraftValueChange: (value: string) => void;
  onReplaceComposerDraft: () => void;
  onSaveQueuedDraft: () => void;
  onSteerDraft: (draftId: string) => void;
}) {
  if (drafts.length === 0 && !editingDraft) return null;

  return (
    <div className="composer-steer-stack" aria-label="Queued steer drafts">
      {drafts.map((draft) => {
        const sending = sendingDraftId === draft.id;
        return (
          <div className={`composer-steer-row ${sending ? "sending" : ""}`} key={draft.id}>
            <span className="composer-steer-row-icon" aria-hidden="true">
              <ArrowUpRight size={13} />
            </span>
            <span className="composer-steer-row-text" title={draft.prompt}>
              {composerSteerPreview(draft.prompt)}
            </span>
            <button
              type="button"
              className="composer-steer-row-action primary"
              disabled={sending}
              aria-label={`Steer queued draft: ${composerSteerPreview(draft.prompt, 60)}`}
              onClick={() => onSteerDraft(draft.id)}
            >
              <ArrowUpRight size={12} />
              <span>{sending ? "Sending" : "Steer"}</span>
            </button>
            <button
              type="button"
              className="composer-steer-row-icon-button"
              disabled={sending}
              data-tooltip="Edit queued steer"
              aria-label="Edit queued steer"
              onClick={() => onEditDraft(draft)}
            >
              <SquarePen size={13} />
            </button>
            <button
              type="button"
              className="composer-steer-row-icon-button"
              disabled={sending}
              data-tooltip="Delete queued steer"
              aria-label="Delete queued steer"
              onClick={() => onDeleteDraft(draft.id)}
            >
              <Trash2 size={13} />
            </button>
            <button
              type="button"
              className="composer-steer-row-icon-button"
              disabled={sending}
              data-tooltip="More"
              aria-label="More queued steer actions"
            >
              <MoreHorizontal size={13} />
            </button>
          </div>
        );
      })}
      {editingDraft ? (
        <div className="composer-steer-edit-backdrop" role="presentation">
          <div
            className="composer-steer-edit-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Edit queued steer"
          >
            <label className="composer-steer-edit-field">
              <span>Edit queued steer</span>
              <textarea
                autoFocus
                value={editDraftValue}
                onChange={(event) => onEditDraftValueChange(event.target.value)}
              />
            </label>
            <div className="composer-steer-edit-actions">
              <button type="button" onClick={onCancelEdit}>
                Cancel
              </button>
              <button
                type="button"
                disabled={!editDraftValue.trim()}
                onClick={onReplaceComposerDraft}
              >
                Replace composer
              </button>
              <button
                type="button"
                className="primary"
                disabled={!editDraftValue.trim()}
                onClick={onSaveQueuedDraft}
              >
                Save queued draft
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
