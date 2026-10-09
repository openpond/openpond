import { ComposerSteerRow } from "./ComposerSteerRow";
import type { ComposerSteerDraft } from "./composer-steer-queue";

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
    <div className="composer-steer-stack" aria-label="Steer drafts">
      {drafts.map((draft) => (
        <ComposerSteerRow
          key={draft.id}
          prompt={draft.prompt}
          sending={sendingDraftId === draft.id}
          onSend={() => onSteerDraft(draft.id)}
          onDelete={() => onDeleteDraft(draft.id)}
          onEdit={() => onEditDraft(draft)}
        />
      ))}
    </div>
  );
}
