import { useState, type FormEvent } from "react";
import type { PrimeComputeProviderStatus } from "@openpond/contracts";
import { KeyRound, RefreshCw, Trash2 } from "../icons";
import type { ComputeSettingsBusy } from "./useComputeSettings";

export function PrimeComputeProviderCard({
  status,
  busy,
  onSave,
  onValidate,
  onDelete,
}: {
  status: PrimeComputeProviderStatus;
  busy: ComputeSettingsBusy;
  onSave: (apiKey: string) => Promise<boolean>;
  onValidate: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const primeBusy = busy?.startsWith("prime-") ?? false;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!apiKey.trim()) return;
    if (await onSave(apiKey)) setApiKey("");
  }

  return (
    <div className="prime-compute-card">
      <div className="prime-compute-header">
        <div className="prime-compute-identity">
          <div>
            <strong>{status.displayName}</strong>
            <small>Remote GPU training and rollout compute</small>
          </div>
        </div>
        <span
          className={`provider-state-pill ${statusTone(status.state)}`}
          aria-label={`Prime status: ${statusLabel(status.state)}`}
        >
          {statusLabel(status.state)}
        </span>
      </div>

      <div className="prime-compute-explainer">
        <p>
          Use Prime Intellect GPUs for training runs. The key stays encrypted
          on this machine and is excluded from datasets and training artifacts.
        </p>
      </div>

      {status.availability ? (
        <dl className="prime-compute-stats">
          <div>
            <dt>Secure H100 offers</dt>
            <dd>{status.availability.availableOfferingCount}</dd>
          </div>
          <div>
            <dt>Lowest listed rate</dt>
            <dd>{formatRate(status.availability.lowestHourlyUsd)}</dd>
          </div>
          <div>
            <dt>Prime SSH keys</dt>
            <dd>{status.availability.registeredSshKeyCount}</dd>
          </div>
        </dl>
      ) : null}

      {status.lastError ? (
        <div className="prime-compute-error" role="status">{status.lastError}</div>
      ) : null}

      <form className="prime-compute-form" onSubmit={(event) => void submit(event)}>
        <label className="settings-select-field">
          <span>Prime Intellect API key</span>
          <input
            type="password"
            value={apiKey}
            disabled={primeBusy}
            placeholder={status.credential.configured ? "Paste a replacement key" : "Paste your Prime API key"}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setApiKey(event.currentTarget.value)}
          />
          <small>
            {status.credential.configured
              ? `${status.credential.redacted} · stored with local AES-256-GCM encryption`
              : "OpenPond performs read-only availability and SSH-key checks when you connect."}
          </small>
        </label>
        <div className="settings-button-row compact prime-compute-actions">
          <button className="settings-primary" disabled={primeBusy || !apiKey.trim()}>
            <KeyRound size={14} />
            <span>{busy === "prime-save" ? "Connecting" : status.credential.configured ? "Replace & verify" : "Connect & verify"}</span>
          </button>
          {status.credential.configured ? (
            <>
              <button
                type="button"
                className="settings-secondary"
                disabled={primeBusy}
                onClick={() => void onValidate()}
              >
                <RefreshCw size={14} className={busy === "prime-validate" ? "settings-spin" : undefined} />
                <span>{busy === "prime-validate" ? "Verifying" : "Verify again"}</span>
              </button>
              <button
                type="button"
                className="settings-icon-button ghost"
                aria-label="Remove Prime Intellect API key"
                title="Remove Prime Intellect API key"
                disabled={primeBusy}
                onClick={() => void onDelete()}
              >
                <Trash2 size={15} />
              </button>
            </>
          ) : null}
        </div>
      </form>

      {status.lastValidatedAt ? (
        <small className="prime-compute-last-checked">
          Last verified {formatDate(status.lastValidatedAt)}
        </small>
      ) : null}
    </div>
  );
}

function statusTone(
  state: PrimeComputeProviderStatus["state"],
): "muted" | "configured" | "ready" | "warning" {
  if (state === "ready" || state === "credential_valid") return "ready";
  if (state === "configured") return "configured";
  if (state === "error") return "warning";
  return "muted";
}

function statusLabel(state: PrimeComputeProviderStatus["state"]): string {
  if (state === "credential_valid") return "Key verified";
  if (state === "configured") return "Verify needed";
  if (state === "disconnected") return "Not connected";
  if (state === "error") return "Check failed";
  return "Ready";
}

function formatRate(value: number | null): string {
  if (value === null) return "Not listed";
  return `$${value.toFixed(value < 10 ? 2 : 0)}/hr`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
