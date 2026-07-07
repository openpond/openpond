import { useEffect, useState } from "react";
import { Github, X } from "../icons";
import {
  SUBMIT_ISSUE_REPOSITORY,
  type SubmitIssueFormInput,
} from "../../lib/submit-issue-command";

type SubmitIssueDialogProps = {
  busy: boolean;
  initialDescription: string;
  open: boolean;
  onClose: () => void;
  onSubmit: (input: SubmitIssueFormInput) => Promise<boolean>;
};

export function SubmitIssueDialog({
  busy,
  initialDescription,
  open,
  onClose,
  onSubmit,
}: SubmitIssueDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState(() => initialDescription.trim());
  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  const submitDisabled = busy || !trimmedTitle || !trimmedDescription;

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription(initialDescription.trim());
  }, [initialDescription, open]);

  useEffect(() => {
    if (!open || busy) return undefined;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose, open]);

  if (!open) return null;

  async function submitIssue() {
    if (submitDisabled) return;
    const sent = await onSubmit({
      title: trimmedTitle,
      description: trimmedDescription,
    });
    if (sent) {
      setTitle("");
      setDescription("");
    }
  }

  return (
    <div className="git-dialog-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
      <section
        className="git-dialog submit-issue-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Submit GitHub issue"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
          event.preventDefault();
          void submitIssue();
        }}
      >
        <button className="git-dialog-close" disabled={busy} type="button" onClick={onClose}>
          <X size={16} />
        </button>
        <div className="git-dialog-icon">
          <Github size={18} />
        </div>
        <h2>Submit issue</h2>
        <div className="git-dialog-row submit-issue-repo-row">
          <span>Repository</span>
          <strong>{SUBMIT_ISSUE_REPOSITORY}</strong>
        </div>
        <label className="git-dialog-field">
          <span>Title</span>
          <input
            autoFocus
            disabled={busy}
            placeholder="Short issue title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="git-dialog-field">
          <span>Description</span>
          <textarea
            disabled={busy}
            placeholder="What happened, what you expected, and any useful context"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <div className="git-dialog-footer">
          <button className="git-dialog-secondary" disabled={busy} type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="git-dialog-primary" disabled={submitDisabled} type="button" onClick={() => void submitIssue()}>
            Submit issue
          </button>
        </div>
      </section>
    </div>
  );
}
