import { useEffect, useRef, useState } from "react";
import type { Session } from "@openpond/contracts";

export function RenameChatDialog({
  session,
  onSave,
  onClose,
}: {
  session: Session;
  onSave: (title: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(session.title);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function handleSubmit() {
    const trimmed = title.trim();
    if (!trimmed) return;
    onSave(trimmed);
    onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  }

  return (
    <div className="git-dialog-backdrop rename-chat-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="git-dialog rename-chat-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-chat-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="rename-chat-title">Rename chat</h2>
        <textarea
          ref={inputRef}
          className="rename-chat-input"
          value={title}
          rows={1}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Chat title"
        />
        <div className="git-dialog-footer">
          <button type="button" className="git-dialog-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="git-dialog-primary"
            autoFocus
            onClick={handleSubmit}
            disabled={!title.trim()}
          >
            Save
          </button>
        </div>
      </section>
    </div>
  );
}
