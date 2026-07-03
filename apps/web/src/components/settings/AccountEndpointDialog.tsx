import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import type { AccountState } from "@openpond/contracts";
import { Save, SlidersHorizontal, X } from "../icons";

type AccountRow = AccountState["accounts"][number];

export type AccountEndpointUpdate = {
  handle: string;
  currentBaseUrl: string | null;
  baseUrl: string;
  apiBaseUrl: string;
};

type AccountEndpointDialogProps = {
  account: AccountRow;
  busy: boolean;
  onClose: () => void;
  onSave: (input: AccountEndpointUpdate) => Promise<void>;
};

function normalizeRequiredUrl(label: string, value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error(`${label} is required.`);
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(`${label} must be an absolute http or https URL.`);
  }
  return trimmed;
}

export function AccountEndpointDialog({
  account,
  busy,
  onClose,
  onSave,
}: AccountEndpointDialogProps) {
  const titleId = useId();
  const [baseUrl, setBaseUrl] = useState(account.baseUrl ?? "");
  const [apiBaseUrl, setApiBaseUrl] = useState(account.apiBaseUrl ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBaseUrl(account.baseUrl ?? "");
    setApiBaseUrl(account.apiBaseUrl ?? "");
    setError(null);
  }, [account.baseUrl, account.apiBaseUrl, account.handle]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    let normalizedBaseUrl: string;
    let normalizedApiBaseUrl: string;
    try {
      normalizedBaseUrl = normalizeRequiredUrl("Base URL", baseUrl);
      normalizedApiBaseUrl = normalizeRequiredUrl("API base URL", apiBaseUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }

    try {
      await onSave({
        handle: account.handle,
        currentBaseUrl: account.baseUrl ?? null,
        baseUrl: normalizedBaseUrl,
        apiBaseUrl: normalizedApiBaseUrl,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <div
      className="git-dialog-backdrop account-endpoint-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="git-dialog account-endpoint-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => void submit(event)}
      >
        <button
          className="git-dialog-close"
          disabled={busy}
          type="button"
          title="Close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={16} />
        </button>
        <div className="git-dialog-icon">
          <SlidersHorizontal size={18} />
        </div>
        <h2 id={titleId}>Environment endpoints</h2>
        <label className="git-dialog-field">
          <span>Base URL</span>
          <input
            autoFocus
            disabled={busy}
            inputMode="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label className="git-dialog-field">
          <span>API base URL</span>
          <input
            disabled={busy}
            inputMode="url"
            value={apiBaseUrl}
            onChange={(event) => setApiBaseUrl(event.target.value)}
          />
        </label>
        {error ? <div className="profile-dialog-warning">{error}</div> : null}
        <div className="git-dialog-footer">
          <button className="git-dialog-secondary" disabled={busy} type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="git-dialog-primary" disabled={busy} type="submit">
            <Save size={14} />
            <span>{busy ? "Saving" : "Update account"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
