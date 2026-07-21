import { useEffect, useState, type FormEvent } from "react";

import { Bot, X } from "../icons";
import { useErrorToast } from "../../app/AppToastContext";
import { AppDialog } from "../dialogs/AppDialog";

export function LabAgentRenameDialog({
  agentId,
  currentName,
  onClose,
  onRename,
}: {
  agentId: string;
  currentName: string;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useErrorToast(error);
  const normalizedName = name.trim().replace(/\s+/g, " ");
  const unchanged = normalizedName === currentName.trim().replace(/\s+/g, " ");

  useEffect(() => {
    setName(currentName);
    setBusy(false);
    setError(null);
  }, [agentId, currentName]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!normalizedName || unchanged || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRename(normalizedName);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppDialog
      ariaLabel={`Rename ${currentName}`}
      backdropClassName="labs-rename-backdrop"
      className="labs-rename-dialog"
      dismissDisabled={busy}
      initialFocusKey={agentId}
      onClose={onClose}
    >
        <header>
          <span className="labs-rename-dialog-icon">
            <Bot size={16} />
          </span>
          <div>
            <h2>Rename agent</h2>
            <p>Change the display name without changing the stable agent ID.</p>
          </div>
          <button
            aria-label="Close rename agent"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            <span>Display name</span>
            <input
              data-autofocus
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <div className="labs-rename-agent-id">
            <span>Agent ID</span>
            <code>{agentId}</code>
          </div>
          <footer>
            <button disabled={busy} type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              disabled={!normalizedName || unchanged || busy}
              type="submit"
            >
              {busy ? "Renaming…" : "Rename"}
            </button>
          </footer>
        </form>
    </AppDialog>
  );
}
