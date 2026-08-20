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

type AccountEndpointDialogProps = {
  account?: AccountRow | null;
  busy: boolean;
  initialApiKey?: string;
  mode?: AccountEndpointDialogMode;
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
  initialApiKey = "",
  mode = "update",
  onClose,
  onSave,
}: AccountEndpointDialogProps) {
  const titleId = useId();
  const connectMode = mode === "connect";
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [advanced, setAdvanced] = useState(false);
  const [baseUrl, setBaseUrl] = useState(
    account?.baseUrl ?? DEFAULT_OPENPOND_WEB_BASE_URL
  );
  const [apiBaseUrl, setApiBaseUrl] = useState(
    account?.apiBaseUrl ?? DEFAULT_OPENPOND_API_BASE_URL
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  useErrorToast(requestError);

  useEffect(() => {
    setApiKey(initialApiKey);
    setAdvanced(false);
    setBaseUrl(account?.baseUrl ?? DEFAULT_OPENPOND_WEB_BASE_URL);
    setApiBaseUrl(account?.apiBaseUrl ?? DEFAULT_OPENPOND_API_BASE_URL);
    setValidationError(null);
    setRequestError(null);
  }, [account?.apiBaseUrl, account?.baseUrl, account?.handle, initialApiKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(null);
    setRequestError(null);
    const trimmedApiKey = apiKey.trim();
    if (connectMode && !trimmedApiKey) {
      setValidationError("API key is required.");
      return;
    }
    let normalizedBaseUrl: string;
    let normalizedApiBaseUrl: string;
    try {
      normalizedBaseUrl = normalizeRequiredUrl("Base URL", baseUrl);
      normalizedApiBaseUrl = normalizeRequiredUrl("API base URL", apiBaseUrl);
    } catch (caught) {
      setValidationError(caught instanceof Error ? caught.message : String(caught));
      return;
    }

    try {
      const accountSelector = accountEndpointSelectorForMode(mode, account);
      await onSave({
        ...accountSelector,
        baseUrl: normalizedBaseUrl,
        apiBaseUrl: normalizedApiBaseUrl,
        apiKey: connectMode ? trimmedApiKey : undefined,
        environment: accountEnvironmentForEndpoints(
          normalizedBaseUrl,
          normalizedApiBaseUrl
        ),
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
        {connectMode ? (
          <label className="git-dialog-toggle account-dialog-advanced-toggle">
            <input
              checked={advanced}
              disabled={busy}
              type="checkbox"
              onChange={(event) => setAdvanced(event.target.checked)}
            />
            <span />
            Advanced
          </label>
        ) : null}
        {!connectMode || advanced ? (
          <div className="account-dialog-advanced-fields">
            <label className="git-dialog-field">
              <span>Base URL</span>
              <input
                autoFocus={!connectMode}
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
          </div>
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

export function accountEnvironmentForEndpoints(
  baseUrl: string,
  apiBaseUrl: string
): "production" | "custom" {
  return baseUrl === DEFAULT_OPENPOND_WEB_BASE_URL &&
    apiBaseUrl === DEFAULT_OPENPOND_API_BASE_URL
    ? "production"
    : "custom";
}
