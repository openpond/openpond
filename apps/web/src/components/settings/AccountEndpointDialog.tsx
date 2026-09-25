import { useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import "../../styles/workspace/git-dialogs.css";
import type { AccountState } from "@openpond/contracts";
import { KeyRound, Save, Settings, Trash2, X } from "../icons";
import { useErrorToast } from "../../app/AppToastContext";

type AccountRow = AccountState["accounts"][number];
type AccountEndpointDialogMode = "update" | "connect";
const DEFAULT_WEB_URL = "https://www.openpond.ai";
const DEFAULT_API_URL = "https://api.openpond.ai";

export type AccountEndpointUpdate = {
  handle?: string;
  currentBaseUrl: string | null;
  baseUrl: string;
  apiBaseUrl: string;
  chatApiBaseUrl?: string | null;
  apiKey?: string;
  environment?: string | null;
};

function suggestedApiUrl(webUrl: string): string {
  try {
    const url = new URL(webUrl);
    const host = url.hostname.toLowerCase();
    if (host === "openpond.ai" || host === "www.openpond.ai") return DEFAULT_API_URL;
  } catch {
    // An incomplete environment URL has no API default.
  }
  return "";
}

function validateUrl(value: string, label: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") return null;
    if (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return null;
  } catch {
    // A partial URL stays in the input until the user submits it.
  }
  return `${label} must be an https:// URL (or http:// for localhost).`;
}

type AccountEndpointDialogProps = {
  account?: AccountRow | null;
  busy: boolean;
  mode?: AccountEndpointDialogMode;
  onClose: () => void;
  onSave: (input: AccountEndpointUpdate) => Promise<void>;
  onRemove?: () => Promise<boolean>;
};

export function AccountEndpointDialog({
  account,
  busy,
  mode = "update",
  onClose,
  onSave,
  onRemove,
}: AccountEndpointDialogProps) {
  const titleId = useId();
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const connectMode = mode === "connect";
  const initialWebUrl = account?.baseUrl ?? DEFAULT_WEB_URL;
  const initialApiUrl = account?.apiBaseUrl ?? suggestedApiUrl(initialWebUrl);
  const [webUrl, setWebUrl] = useState(initialWebUrl);
  const [apiUrl, setApiUrl] = useState(initialApiUrl);
  const [apiKey, setApiKey] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  useErrorToast(requestError);

  function changeWebUrl(value: string) {
    setWebUrl(value);
    setApiUrl(value.trim().replace(/\/+$/, "") === initialWebUrl ? initialApiUrl : suggestedApiUrl(value));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(null);
    setRequestError(null);
    const trimmedApiKey = apiKey.trim();
    const trimmedWebUrl = webUrl.trim().replace(/\/+$/, "");
    const trimmedApiUrl = apiUrl.trim().replace(/\/+$/, "");
    const error =
      (connectMode && !trimmedApiKey ? "API key is required." : null) ??
      validateUrl(trimmedWebUrl, "Environment URL") ??
      validateUrl(trimmedApiUrl, "API URL");
    if (error) {
      setValidationError(error);
      if (error.startsWith("Environment URL") || error.startsWith("API URL")) {
        if (advancedRef.current) advancedRef.current.open = true;
      }
      return;
    }
    try {
      await onSave({
        handle: connectMode ? undefined : account?.handle,
        currentBaseUrl: connectMode ? null : account?.baseUrl ?? null,
        baseUrl: trimmedWebUrl,
        apiBaseUrl: trimmedApiUrl,
        chatApiBaseUrl: connectMode || trimmedApiUrl !== initialApiUrl
          ? null
          : account?.chatApiBaseUrl,
        apiKey: trimmedApiKey || undefined,
        environment: new URL(trimmedWebUrl).hostname.replace(/^www\./, "") === "openpond.ai"
          ? "production"
          : "custom",
      });
    } catch (caught) {
      setRequestError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function remove() {
    if (!onRemove) return;
    if (await onRemove()) onClose();
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
        <button className="git-dialog-close" disabled={busy} type="button" title="Close" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
        <div className="git-dialog-icon">
          {connectMode ? <KeyRound size={18} /> : <Settings size={18} />}
        </div>
        <h2 id={titleId}>{connectMode ? "Add account" : "Account settings"}</h2>
        <p>{connectMode ? "Connect an OpenPond account with an API key." : "Review this account and its verified key access."}</p>

        {!connectMode && account ? (
          <div className="account-dialog-details">
            <div><span>Account</span><strong>{account.displayLabel || account.handle}</strong></div>
            {account.email ? <div><span>Email</span><strong>{account.email}</strong></div> : null}
            <div><span>Handle</span><strong>{account.handle}</strong></div>
            <div><span>API key</span><strong>{account.apiKeyHint ?? (account.authHealth === "signed_in" ? "Connected with a session" : "No saved API key")}</strong></div>
            <div><span>Access</span><strong>{account.apiKeyAccess ? (account.apiKeyAccess.teamId ? "This workspace" : account.apiKeyAccess.ownerType === "user" ? "All my workspaces" : "Account access") : "Not verified"}</strong></div>
            {account.apiKeyAccess ? <div><span>Scopes</span><strong>{account.apiKeyAccess.scopes.join(", ") || "No scopes"}</strong></div> : null}
          </div>
        ) : null}

        {connectMode ? (
          <label className="git-dialog-field">
            <span>API key</span>
            <input autoComplete="off" disabled={busy} placeholder="opk_..." type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          </label>
        ) : null}
        <details className="account-dialog-advanced" ref={advancedRef}>
          <summary>Advanced</summary>
          <div className="account-dialog-advanced-fields">
            {!connectMode ? (
              <label className="git-dialog-field">
                <span>Replace API key</span>
                <input autoComplete="off" disabled={busy} placeholder="Leave blank to keep the current key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
                <small>Enter a new key to replace the saved credential.</small>
              </label>
            ) : null}
            <label className="git-dialog-field">
              <span>Environment URL</span>
              <input disabled={busy} inputMode="url" spellCheck={false} type="url" value={webUrl} onChange={(event) => changeWebUrl(event.target.value)} />
              <small>Change this URL to connect this account to another environment.</small>
            </label>
            <label className="git-dialog-field">
              <span>API URL</span>
              <input disabled={busy} inputMode="url" spellCheck={false} type="url" value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} />
              <small>Enter the API URL for a custom environment.</small>
            </label>
          </div>
        </details>
        {validationError ? <div className="profile-dialog-warning">{validationError}</div> : null}
        <div className="git-dialog-footer account-dialog-footer">
          <div className="account-dialog-save-actions">
            {!connectMode && onRemove ? (
              <button className="git-dialog-secondary account-dialog-remove" disabled={busy} type="button" onClick={() => void remove()}>
                <Trash2 size={14} /> Remove account
              </button>
            ) : null}
            <button className="git-dialog-secondary" disabled={busy} type="button" onClick={onClose}>Cancel</button>
            <button className="git-dialog-primary" disabled={busy} type="submit">
              <Save size={14} />
              <span>{busy ? "Saving" : connectMode ? "Connect account" : "Save changes"}</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
