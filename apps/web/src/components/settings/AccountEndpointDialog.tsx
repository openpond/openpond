import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import "../../styles/workspace/git-dialogs.css";
import type { AccountState } from "@openpond/contracts";
import { KeyRound, Save, Settings, X } from "../icons";
import { useErrorToast } from "../../app/AppToastContext";

type AccountRow = AccountState["accounts"][number];
type AccountEndpointDialogMode = "update" | "connect";
const DEFAULT_OPENPOND_WEB_BASE_URL = "https://openpond.ai";
const DEFAULT_OPENPOND_API_BASE_URL = "https://api.openpond.ai";

export type AccountEndpointUpdate = {
  handle?: string;
  currentBaseUrl: string | null;
  baseUrl: string;
  apiBaseUrl: string;
  chatApiBaseUrl?: string | null;
  apiKey?: string;
  environment?: string | null;
};

export function accountEndpointSelectorForMode(
  mode: AccountEndpointDialogMode,
  account: Pick<AccountRow, "handle" | "baseUrl"> | null | undefined,
): Pick<AccountEndpointUpdate, "handle" | "currentBaseUrl"> {
  if (mode === "connect") {
    return {
      handle: undefined,
      currentBaseUrl: null,
    };
  }
  return {
    handle: account?.handle,
    currentBaseUrl: account?.baseUrl ?? null,
  };
}

export function accountEndpointConfigForMode(
  mode: AccountEndpointDialogMode,
  account: Pick<
    AccountRow,
    "baseUrl" | "apiBaseUrl" | "chatApiBaseUrl" | "environment"
  > | null | undefined,
): Pick<
  AccountEndpointUpdate,
  "baseUrl" | "apiBaseUrl" | "chatApiBaseUrl" | "environment"
> {
  if (mode === "update" && account) {
    return {
      baseUrl: account.baseUrl ?? DEFAULT_OPENPOND_WEB_BASE_URL,
      apiBaseUrl: account.apiBaseUrl ?? DEFAULT_OPENPOND_API_BASE_URL,
      chatApiBaseUrl: account.chatApiBaseUrl,
      environment: account.environment ?? "production",
    };
  }

  return {
    baseUrl: DEFAULT_OPENPOND_WEB_BASE_URL,
    apiBaseUrl: DEFAULT_OPENPOND_API_BASE_URL,
    environment: "production",
  };
}

type AccountEndpointDialogProps = {
  account?: AccountRow | null;
  busy: boolean;
  initialApiKey?: string;
  mode?: AccountEndpointDialogMode;
  onClose: () => void;
  onSave: (input: AccountEndpointUpdate) => Promise<void>;
};

export function AccountEndpointDialog({
  account,
  busy,
  initialApiKey = "",
  mode = "update",
  onClose,
  onSave,
}: AccountEndpointDialogProps) {
  const titleId = useId();
  const connectMode = mode === "connect";
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  useErrorToast(requestError);

  useEffect(() => {
    setApiKey(initialApiKey);
    setValidationError(null);
    setRequestError(null);
  }, [account?.handle, initialApiKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(null);
    setRequestError(null);
    const trimmedApiKey = apiKey.trim();
    if (connectMode && !trimmedApiKey) {
      setValidationError("API key is required.");
      return;
    }
    try {
      const accountSelector = accountEndpointSelectorForMode(mode, account);
      const endpointConfig = accountEndpointConfigForMode(mode, account);
      await onSave({
        ...accountSelector,
        ...endpointConfig,
        apiKey: connectMode ? trimmedApiKey : undefined,
      });
    } catch (caught) {
      setRequestError(caught instanceof Error ? caught.message : String(caught));
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
          {connectMode ? <KeyRound size={18} /> : <Settings size={18} />}
        </div>
        <h2 id={titleId}>{connectMode ? "Add account" : "Account environment"}</h2>
        {connectMode ? (
          <p>Enter your OpenPond API key to connect another account.</p>
        ) : (
          <p>Update the web and API endpoints used by this account.</p>
        )}
        {connectMode ? (
          <label className="git-dialog-field">
            <span>API key</span>
            <input
              autoFocus
              disabled={busy}
              placeholder="opk_..."
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
        ) : null}
        {validationError ? <div className="profile-dialog-warning">{validationError}</div> : null}
        <div className="git-dialog-footer">
          <button className="git-dialog-secondary" disabled={busy} type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="git-dialog-primary" disabled={busy} type="submit">
            <Save size={14} />
            <span>{busy ? "Saving" : connectMode ? "Connect account" : "Update account"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
