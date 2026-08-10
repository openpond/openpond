import { ArrowUpRight, Reply, Trash2 } from "../icons";
import {
  composerSteerPreview,
  type ComposerSteerDraft,
} from "./composer-steer-queue";

export function ComposerSteerQueue({
  drafts,
  sendingDraftId,
  onDeleteDraft,
  onEditDraft,
  onSteerDraft,
}: {
  drafts: ComposerSteerDraft[];
  sendingDraftId: string | null;
  onDeleteDraft: (draftId: string) => void;
  onEditDraft: (draft: ComposerSteerDraft) => void;
  onSteerDraft: (draftId: string) => void;
}) {
  if (drafts.length === 0) return null;

  return (
    <div className="composer-steer-stack" aria-label="Queued steer drafts">
      {drafts.map((draft) => {
        const sending = sendingDraftId === draft.id;
        return (
          <div
            className={`composer-steer-row ${sending ? "sending" : ""}`}
            key={draft.id}
          >
            <span className="composer-steer-row-icon" aria-hidden="true">
              <Reply size={13} />
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
              data-tooltip="Delete queued steer"
              aria-label="Delete queued steer"
              onClick={() => onDeleteDraft(draft.id)}
            >
              <Trash2 size={13} />
            </button>
            <button
              type="button"
              className="composer-steer-row-action"
              disabled={sending}
              aria-label={`Edit message: ${composerSteerPreview(
                draft.prompt,
                60,
              )}`}
              onClick={() => onEditDraft(draft)}
            >
              <span>Edit message</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
