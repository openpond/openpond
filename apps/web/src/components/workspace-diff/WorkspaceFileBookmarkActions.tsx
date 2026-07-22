import type { SidebarFileBookmark } from "@openpond/contracts";
import { Bookmark, BookmarkX, Pin, PinOff } from "../icons";

export function WorkspaceFileBookmarkActions({
  className,
  currentStatus,
  onSetStatus,
}: {
  className?: string;
  currentStatus: SidebarFileBookmark["status"] | null;
  onSetStatus: (status: "pinned" | "saved_for_later" | "none") => void;
}) {
  const pinned = currentStatus === "pinned";
  const saved = currentStatus === "saved_for_later";
  return (
    <span
      className={`workspace-file-bookmark-actions ${className ?? "workspace-file-heading-actions"}`}
    >
      <button
        type="button"
        className={pinned ? "active" : undefined}
        data-tooltip={pinned ? "Unpin file" : "Pin file"}
        aria-label={pinned ? "Unpin file" : "Pin file"}
        aria-pressed={pinned}
        onClick={() => onSetStatus(pinned ? "none" : "pinned")}
      >
        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </button>
      <button
        type="button"
        className={saved ? "active" : undefined}
        data-tooltip={saved ? "Remove from Save for later" : "Save file for later"}
        aria-label={saved ? "Remove from Save for later" : "Save file for later"}
        aria-pressed={saved}
        onClick={() => onSetStatus(saved ? "none" : "saved_for_later")}
      >
        {saved ? <BookmarkX size={14} /> : <Bookmark size={14} />}
      </button>
    </span>
  );
}
