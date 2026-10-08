import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RemoteAccessSettingsStatus,
  RemoteAccessSettingsAction,
} from "@openpond/contracts";
import { organizationApi } from "../../api/organization-api";
import { normalizeOpenPondOrganization } from "../../lib/cloud-project-utils";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { RemoteAccessDeviceRow } from "./RemoteAccessDeviceRow";

const labels: Record<RemoteAccessSettingsStatus["state"], string> = {
  signed_out: "Sign in required",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
  off: "Off",
  update_required: "Update required",
};
const reasons: Record<string, string> = {
  protocol_unsupported:
    "Install the latest OpenPond desktop app to connect to this relay.",
  authentication_timeout:
    "The relay did not confirm authentication. Retry the connection.",
  authentication_expired: "Relay authentication expired. Retry the connection.",
  relay_backpressure: "The relay is busy. OpenPond will retry automatically.",
  connection_lost:
    "The relay connection was lost. OpenPond will retry automatically.",
  connection_failed:
    "Unable to reach the relay. Check your network connection and retry.",
};

function settingsError(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  return error.message === "remote_account_changing"
    ? "Your account settings are being updated. Try again shortly."
    : error.message;
}

export function AccountRemoteAccessSettings({
  connection,
  onError,
}: {
  connection: ClientConnection | null;
  onError(message: string | null): void;
}) {
  const [status, setStatus] = useState<RemoteAccessSettingsStatus | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const latestStatus = useRef(status);
  const mutationPending = useRef(false);
  const refreshRequest = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (refreshRequest.current) return;
    const version = ++requestVersion.current;
    if (!connection) {
      latestStatus.current = null;
      setStatus(null);
      return;
    }
    const controller = new AbortController();
    refreshRequest.current = controller;
    setLoadError(null);
    try {
      const value = await apiFetch<RemoteAccessSettingsStatus>(
        connection,
        "/v1/account-remote-access",
        { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) },
      );
      if (requestVersion.current === version) {
        latestStatus.current = value;
        setStatus(value);
      }
    } catch (error) {
      if (!controller.signal.aborted && requestVersion.current === version) {
        setLoadError(error instanceof Error && error.name === "TimeoutError"
          ? "Loading your computers timed out. Retry to load their current status."
          : settingsError(error, "Unable to load your computers."));
      }
    } finally {
      if (refreshRequest.current === controller) refreshRequest.current = null;
    }
  }, [connection]);
  useEffect(() => {
    latestStatus.current = null;
    setStatus(null);
    setLoadError(null);
    void refresh();
    let lastRefresh = Date.now();
    const timer = window.setInterval(() => {
      if (mutationPending.current) return;
      const updating = ["connecting", "reconnecting"].includes(
        latestStatus.current?.state ?? "",
      );
      if (updating || Date.now() - lastRefresh >= 15_000) {
        lastRefresh = Date.now();
        void refresh();
      }
    }, 1_000);
    return () => {
      ++requestVersion.current;
      refreshRequest.current?.abort();
      refreshRequest.current = null;
      window.clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    setTeamName(null);
    const teamId = status?.team?.id;
    if (!connection || !status?.account || !teamId) return;
    let active = true;
    void organizationApi
      .organizations(connection)
      .then((payload) => {
        const team = payload.organizations
          .map(normalizeOpenPondOrganization)
          .find((organization) => organization?.teamId === teamId);
        if (active && team)
          setTeamName(team.displayName || team.name || team.slug);
      })
      .catch(() => {
        /* The authenticated workspace ID remains visible if its name cannot be fetched. */
      });
    return () => {
      active = false;
    };
  }, [connection, status?.account?.id, status?.team?.id]);
  async function act(
    action: RemoteAccessSettingsAction,
    body: Record<string, unknown> = {},
  ) {
    if (!connection || mutationPending.current) return;
    refreshRequest.current?.abort();
    refreshRequest.current = null;
    const version = ++requestVersion.current;
    mutationPending.current = true;
    setBusy(true);
    onError(null);
    try {
      const value = await apiFetch<RemoteAccessSettingsStatus>(
        connection,
        `/v1/account-remote-access/${action}`,
        { method: "POST", body: JSON.stringify(body) },
      );
      if (requestVersion.current === version) {
        latestStatus.current = value;
        setStatus(value);
      }
    } catch (error) {
      if (requestVersion.current === version) {
        onError(
          settingsError(error, "Unable to update remote access."),
        );
        await refresh();
      }
    } finally {
      mutationPending.current = false;
      setBusy(false);
    }
  }
  const availableAccount = !!status?.account;
  return (
    <section className="account-settings remote-access-settings">
      <h1>Remote access</h1>
      <p>
        View this computer’s tasks and send instructions from your signed-in
        OpenPond account. Tasks run on this computer.
      </p>
      {status?.account && (
        <p>
          Account: {status.account.label} · {status.team
            ? `Workspace: ${teamName ?? status.team.id}`
            : "Personal account"}
        </p>
      )}
      <div className="account-summary remote-access-summary">
        <div className="account-summary-main">
          <div>
            <strong>
              This computer
              {status?.device?.name ? ` · ${status.device.name}` : ""}
            </strong>
            <small role="status">
              {status ? labels[status.state] : loadError ? "Unable to load" : "Checking connection…"}
            </small>
            {status?.device && (
              <small>
                Catalog synced{" "}
                {status.device.lastCatalogSyncAt
                  ? new Date(status.device.lastCatalogSyncAt).toLocaleString()
                  : "never"}
              </small>
            )}
          </div>
        </div>
        <div className="account-summary-actions">
          <button
            className="settings-secondary"
            type="button"
            disabled={busy || !availableAccount}
            onClick={() => void act(status?.enabled ? "disable" : "enable")}
          >
            {busy ? "Updating…" : status?.enabled ? "Turn off" : "Turn on"}
          </button>
          <button
            className="settings-secondary"
            type="button"
            disabled={busy || (status ? !availableAccount || !status.enabled : !connection || !loadError)}
            onClick={() => status ? void act("retry") : void refresh()}
          >
            {status ? "Retry connection" : "Retry loading"}
          </button>
        </div>
      </div>
      {loadError && <p role="alert">{loadError}</p>}
      {status?.state === "signed_out" && (
        <p>Sign in from Settings → Account to connect this computer.</p>
      )}
      {status?.account && !status.team && (
        <p>
          Personal access includes tasks owned by your OpenPond account.
          To use workspace tasks, select that workspace in Settings → Account.
        </p>
      )}
      {status?.team && (
        <p>
          This connection includes tasks owned by the selected workspace.
          Choose Personal account in Settings → Account to use your personal tasks.
        </p>
      )}
      {status?.reason && reasons[status.reason] && (
        <p role="status">
          {reasons[status.reason]}
          {status.state === "update_required" &&
          status.minimumSupportedProtocolVersion
            ? ` This relay requires protocol ${status.minimumSupportedProtocolVersion}; this app uses protocol ${status.supportedProtocolVersion}.`
            : ""}
        </p>
      )}
      {status?.device?.removed && (
        <p>
          This computer was removed. Turn on remote access here to enroll it
          again.
        </p>
      )}
      <p>
        Turning off remote access applies to your personal account and its
        workspaces on this computer. It stays off after restart and sign-in until
        you turn it on here. Sleeping or closing the app makes this computer unavailable.
      </p>
      <p>
        History fetched through OpenPond may be cached for 24 hours. Turning off
        or removing a computer blocks remote history and controls; its local
        history stays on that computer.
      </p>
      <h2>Your computers</h2>
      {status?.devices.length === 0 && <p>No computers are enrolled.</p>}
      {status?.devices.map((device) => (
        <RemoteAccessDeviceRow
          key={device.id}
          device={device}
          self={device.id === status.device?.id}
          busy={busy}
          webBaseUrl={status.webBaseUrl}
          teamId={status.team?.id ?? null}
          act={act}
        />
      ))}
      {!!status?.unresolvedTasks.length && (
        <>
          <h2>Choose ownership for older tasks</h2>
          <p>
            These tasks have no recorded account owner. Only add tasks that
            belong to you. Their local history is preserved.
          </p>
          {status.unresolvedTasks.map((task) => (
            <div className="account-summary" key={task.id}>
              <strong className="remote-access-task-title">{task.title}</strong>
              <button
                className="settings-secondary"
                type="button"
                disabled={busy}
                onClick={() =>
                  void act("attach", {
                    sessionId: task.id,
                    expectedRevision: task.revision,
                  })
                }
              >
                Add to my account
              </button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
