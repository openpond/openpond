import { ErrorToast } from "../common/ErrorToast";
import { useRef, useState, type FormEvent } from "react";
import type { BootstrapPayload, ProviderSettings } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { OPENPOND_ICON_URL } from "../../lib/public-assets";
import { AppDialog } from "../dialogs/AppDialog";
import { Check, ExternalLink, X } from "../icons";
import { useAccountSettings } from "../settings/useAccountSettings";
import { OnboardingAgentCard } from "./OnboardingAgentCard";
import "../../styles/workspace/git-dialogs.css";
import "../../styles/settings/settings-forms.css";
import "../../styles/onboarding.css";

const API_KEYS_URL = "https://www.openpond.ai/api-keys";

export function GettingStartedDialog({ connection, payload, onPayload, onClose }: {
  connection: ClientConnection;
  payload: BootstrapPayload;
  onPayload: (payload: BootstrapPayload) => void;
  onClose: () => void;
}) {
  const [connectingAccount, setConnectingAccount] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const latestPayload = useRef(payload);
  latestPayload.current = payload;
  const accountSettings = useAccountSettings({ connection, onPayload, onError: setError });
  function applyProviders(providers: ProviderSettings) {
    onPayload({ ...latestPayload.current, providers });
  }
  const accountConnected = payload.account.state === "signed_in";

  async function connectAccount(event: FormEvent) {
    event.preventDefault();
    if (!apiKey.trim() || accountSettings.saving) return;
    try {
      await accountSettings.saveAccount({ apiKey, baseUrl: "https://www.openpond.ai", apiBaseUrl: "https://api.openpond.ai", environment: "production" });
      setApiKey("");
      setConnectingAccount(false);
    } catch { /* The account hook supplies the actionable error. */ }
  }

  async function openApiKeys() {
    setError(null);
    try {
      const browser = window.openpond?.browser;
      if (browser?.openExternal) {
        const result = await browser.openExternal({ conversationId: "openpond-get-started", url: API_KEYS_URL });
        if (!result.ok) throw new Error(result.error ?? "Could not open API keys in your browser.");
      } else window.open(API_KEYS_URL, "_blank", "noopener,noreferrer");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  return <>
    <AppDialog ariaLabel="Get started with OpenPond" backdropClassName="git-dialog-backdrop" className="git-dialog getting-started-dialog" onClose={onClose}>
      <button type="button" className="git-dialog-close" aria-label="Close get started" title="Close" onClick={onClose}><X size={16} /></button>
      <header className="getting-started-header">
        <h2>Get started with OpenPond</h2>
      </header>
      <ol className="getting-started-cards">
        <li className="getting-started-card">
          <img className="getting-started-provider-icon" src={OPENPOND_ICON_URL} alt="" />
          <h3>OpenPond account</h3>
          <div className="getting-started-card-status" role="status">
            {accountConnected ? <span><Check size={16} /> Connected</span> : <a href={API_KEYS_URL} onClick={event => { event.preventDefault(); setError(null); setConnectingAccount(true); }}>Connect account</a>}
          </div>
        </li>
        <OnboardingAgentCard providerId="codex" connection={connection} config={payload.providers.providers.codex} onProviders={applyProviders} />
        <OnboardingAgentCard providerId="claude-code" connection={connection} config={payload.providers.providers["claude-code"]} onProviders={applyProviders} />
      </ol>
    </AppDialog>
    {connectingAccount ? <AppDialog ariaLabel="Connect OpenPond account" backdropClassName="git-dialog-backdrop getting-started-account-backdrop" className="git-dialog getting-started-account-dialog" onClose={() => setConnectingAccount(false)} dismissDisabled={accountSettings.saving}>
      <button type="button" className="git-dialog-close" aria-label="Close account connection" disabled={accountSettings.saving} onClick={() => setConnectingAccount(false)}><X size={16} /></button>
      <h2>Connect OpenPond</h2>
      <a href={API_KEYS_URL} target="_blank" rel="noreferrer" className="getting-started-key-link" onClick={event => { event.preventDefault(); void openApiKeys(); }}>Create an API key <ExternalLink size={12} /></a>
      <form onSubmit={event => void connectAccount(event)}>
        <label className="git-dialog-field"><span>OpenPond API key</span><input data-autofocus type="password" autoComplete="off" spellCheck={false} placeholder="opk_…" value={apiKey} disabled={accountSettings.saving} onChange={event => { setApiKey(event.target.value); setError(null); }} /></label>
        {error ? <ErrorToast error={error} /> : null}
        <button className="git-dialog-primary" type="submit" disabled={accountSettings.saving || !apiKey.trim()}>{accountSettings.saving ? "Connecting…" : "Connect account"}</button>
      </form>
    </AppDialog> : null}
  </>;
}
