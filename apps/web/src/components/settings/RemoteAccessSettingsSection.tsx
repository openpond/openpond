import type { RemoteAccessPeer, RemoteAccessStatus } from "@openpond/contracts";
import { Power, RefreshCw, RadioTower, WifiOff } from "../icons";

type RemoteAccessSettingsSectionProps = {
  status: RemoteAccessStatus | null;
  busy:
    | "refresh"
    | "enable"
    | "disable"
    | "copy-link"
    | "copy-up-command"
    | "copy-command"
    | "copy-serve-setup"
    | "copy-operator"
    | null;
  flashTailscaleUp: boolean;
  refresh: () => Promise<void>;
  enableRemoteAccess: () => Promise<unknown>;
  disableRemoteAccess: () => Promise<void>;
  copyRemoteLink: () => Promise<void>;
  copyTailscaleUpCommand: () => Promise<void>;
  copyServeCommand: () => Promise<void>;
  copyServeSetupUrl: () => Promise<void>;
  copyOperatorCommand: () => Promise<void>;
  createRemoteLink: () => Promise<void>;
};

export function RemoteAccessSettingsSection({
  status,
  busy,
  flashTailscaleUp,
  refresh,
  enableRemoteAccess,
  disableRemoteAccess,
  copyRemoteLink,
  copyTailscaleUpCommand,
  copyServeCommand,
  copyServeSetupUrl,
  copyOperatorCommand,
  createRemoteLink,
}: RemoteAccessSettingsSectionProps) {
  const installed = status?.tailscale.installed ?? false;
  const configured = status?.serve.enabled ?? false;
  const reachable = status?.serve.reachable ?? false;
  const canEnable = Boolean(status?.webUiAvailable && installed);
  const canCreateLink = configured ? Boolean(status?.remoteWebUrl) : canEnable;
  const peers = status?.tailscale.peers ?? [];
  const clients = peers.filter((peer) => !peer.isSelf);
  const needsOperatorSetup = Boolean(status?.tailscale.error?.includes("set --operator"));
  const showRemoteLink = Boolean(configured && status?.remoteWebUrl);

  return (
    <section className="account-settings remote-access-settings">
      <h1>Remote access</h1>

      <div className="account-summary remote-access-summary">
        <div className="account-summary-main">
          <div className={`remote-access-icon ${reachable ? "online" : configured ? "configured" : ""}`}>
            {installed ? <RadioTower size={18} /> : <WifiOff size={18} />}
          </div>
          <div>
            <strong>{reachable ? "Tailscale Serve is reachable" : configured ? "Tailscale Serve is configured" : "Tailscale Serve is off"}</strong>
            <small>{status ? remoteAccessSubtitle(status) : "Checking Tailscale"}</small>
          </div>
        </div>
        <div className="account-summary-actions">
          <button
            type="button"
            className="settings-icon-button"
            title="Refresh remote access"
            aria-label="Refresh remote access"
            disabled={busy !== null}
            onClick={() => void refresh()}
          >
            <RefreshCw className={busy === "refresh" ? "settings-spin" : ""} size={15} />
          </button>
          <button
            type="button"
            className="settings-secondary"
            disabled={busy !== null || !installed || (!configured && !canEnable)}
            onClick={() => void (configured ? disableRemoteAccess() : enableRemoteAccess())}
          >
            <Power size={15} />
            <span>{configured ? (busy === "disable" ? "Turning off" : "Turn off") : busy === "enable" ? "Turning on" : "Turn on"}</span>
          </button>
        </div>
      </div>

      <div className="account-list">
        <div className="account-list-heading remote-access-link-heading">
          <div>
            <span>OpenPond link</span>
            <small>{showRemoteLink ? "Browser UI" : "Tailscale + Serve"}</small>
          </div>
        </div>
        {showRemoteLink && (
          <RemoteAccessValueRow
            label="Remote URL"
            value={status?.remoteWebUrl ?? null}
            actionLabel={busy === "copy-link" ? "Copying" : "Copy"}
            disabled={!status?.remoteWebUrl || busy !== null}
            onAction={copyRemoteLink}
          />
        )}
        <RemoteAccessValueRow
          label="Tailscale up"
          value={status?.tailscaleUpCommand ?? null}
          flash={flashTailscaleUp}
          actionLabel={busy === "copy-up-command" ? "Copying" : "Copy"}
          disabled={!status?.tailscaleUpCommand || busy !== null}
          onAction={copyTailscaleUpCommand}
        />
        <RemoteAccessValueRow
          label="Serve command"
          value={status?.serveCommand ?? null}
          actionLabel={busy === "copy-command" ? "Copying" : "Copy"}
          disabled={!status?.serveCommand || busy !== null}
          onAction={copyServeCommand}
        />
        {status?.serve.setupUrl && (
          <RemoteAccessValueRow
            label="Enable Serve"
            value={status.serve.setupUrl}
            actionLabel={busy === "copy-serve-setup" ? "Copying" : "Copy"}
            disabled={busy !== null}
            onAction={copyServeSetupUrl}
          />
        )}
        {needsOperatorSetup && (
          <RemoteAccessValueRow
            label="One-time setup"
            value={status?.operatorCommand ?? null}
            actionLabel={busy === "copy-operator" ? "Copying" : "Copy"}
            disabled={!status?.operatorCommand || busy !== null}
            onAction={copyOperatorCommand}
          />
        )}
        <RemoteAccessValueRow label="Local target" value={status?.localUrl ?? null} />
        {status?.tailscale.authUrl && <RemoteAccessValueRow label="Tailscale login" value={status.tailscale.authUrl} />}
        <RemoteAccessValueRow label="Disable command" value={status?.disableCommand ?? null} />
      </div>

      <div className="account-list">
        <div className="account-list-heading remote-access-link-heading">
          <div>
            <span>Authorized clients</span>
            <small>{clients.length} devices</small>
          </div>
          <button
            type="button"
            className="settings-secondary"
            disabled={busy !== null || !canCreateLink}
            onClick={() => void createRemoteLink()}
          >
            <span>{configured ? "Copy link" : "Create link"}</span>
          </button>
        </div>
        {!status ? (
          <div className="empty-account-list">
            <strong>Checking clients</strong>
            <span>Loading tailnet devices.</span>
          </div>
        ) : clients.length === 0 ? (
          <div className="empty-account-list">
            <strong>No clients reported</strong>
            <span>{status?.tailscale.running ? "Tailscale did not return peer devices." : "Tailscale is not running."}</span>
          </div>
        ) : (
          clients.map((peer) => <RemoteAccessPeerRow key={peer.id} peer={peer} />)
        )}
      </div>

      <div className="account-list">
        <div className="account-list-heading">
          <span>Remote environment</span>
          <small>{status?.tailscale.tailnetName ?? "Tailnet"}</small>
        </div>
        <RemoteAccessEnvironmentGrid status={status} />
      </div>

      {status?.serve.configText && (
        <div className="remote-access-config">
          <div className="account-list-heading">
            <span>Tailscale config</span>
            <small>{status.serve.enabled ? "OpenPond target found" : "No OpenPond target"}</small>
          </div>
          <pre>{status.serve.configText}</pre>
        </div>
      )}
    </section>
  );
}

function RemoteAccessValueRow({
  actionLabel,
  disabled,
  flash,
  label,
  onAction,
  value,
}: {
  actionLabel?: string;
  disabled?: boolean;
  flash?: boolean;
  label: string;
  onAction?: () => Promise<void>;
  value: string | null;
}) {
  return (
    <div className="product-row remote-access-value-row">
      <div>
        <strong className={flash ? "flash" : undefined}>{label}</strong>
        <code>{value ?? "Not available"}</code>
      </div>
      {onAction && (
        <button type="button" className="settings-secondary" disabled={disabled} onClick={() => void onAction()}>
          <span>{actionLabel ?? "Copy"}</span>
        </button>
      )}
    </div>
  );
}

function RemoteAccessEnvironmentGrid({ status }: { status: RemoteAccessStatus | null }) {
  const topItems = [
    { label: "State", value: status?.tailscale.backendState ?? "Unknown" },
    { label: "Machine", value: status?.tailscale.machineName ?? "Unknown" },
    { label: "Tailnet", value: status?.tailscale.tailnetName ?? "Unknown" },
  ];
  const bottomItems = [
    { label: "Tailscale IP", value: status?.tailscale.tailscaleIps.join(", ") || "Unknown" },
    { label: "HTTPS host", value: status?.serve.httpsHost ?? status?.tailscale.dnsName ?? "Unknown" },
  ];

  return (
    <div className="remote-access-environment">
      <div className="remote-access-environment-row three">
        {topItems.map((item) => (
          <RemoteAccessEnvironmentCell key={item.label} label={item.label} value={item.value} />
        ))}
      </div>
      <div className="remote-access-environment-row two">
        {bottomItems.map((item) => (
          <RemoteAccessEnvironmentCell key={item.label} label={item.label} value={item.value} />
        ))}
      </div>
    </div>
  );
}

function RemoteAccessEnvironmentCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="remote-access-environment-cell">
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function RemoteAccessPeerRow({ peer }: { peer: RemoteAccessPeer }) {
  return (
    <div className="account-row remote-access-peer-row">
      <div className={`remote-access-peer-dot ${peer.online ? "online" : ""}`} />
      <div className="account-details">
        <strong>{peer.name}</strong>
        <span>{peer.dnsName ?? peer.tailscaleIps[0] ?? "No address"}</span>
      </div>
      <span className={`account-state ${peer.online ? "signed_in" : ""}`}>{peer.online ? "Online" : "Offline"}</span>
      <span className="account-state">{peer.os ?? "Unknown"}</span>
    </div>
  );
}

function remoteAccessSubtitle(status: RemoteAccessStatus): string {
  if (!status.tailscale.installed) return "Tailscale is not installed";
  if (!status.tailscale.running) return status.tailscale.authUrl ? "Tailscale needs sign-in" : "Tailscale is not running";
  if (!status.webUiAvailable) return "Browser UI is not served by this process";
  if (status.serve.reachable) return status.remoteUrl ?? "Tailnet link ready";
  return status.remoteUrl ? `${status.remoteUrl} ready to configure` : "Tailnet DNS unavailable";
}
