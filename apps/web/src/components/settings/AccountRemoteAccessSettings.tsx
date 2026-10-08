import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteDevice } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";

type Status = { state: string; enabled: boolean; device: RemoteDevice | null; devices: RemoteDevice[];
  unresolvedTasks: { id: string; title: string; revision: string }[] };

export function AccountRemoteAccessSettings({ connection, onError }: {
  connection: ClientConnection | null; onError(message: string | null): void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const requestVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    if (!connection) { setStatus(null); return; }
    try { const value = await apiFetch<Status>(connection, "/v1/account-remote-access");
      if (requestVersion.current === version) setStatus(value); }
    catch (error) { if (requestVersion.current === version) onError(error instanceof Error ? error.message : "Unable to load your computers."); }
  }, [connection, onError]);
  useEffect(() => { setStatus(null); void refresh(); const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { ++requestVersion.current; window.clearInterval(timer); }; }, [refresh]);
  async function act(action: string, body: Record<string, unknown> = {}) {
    if (!connection || busy) return;
    const version = ++requestVersion.current;
    setBusy(true);
    try { const value = await apiFetch<Status>(connection, `/v1/account-remote-access/${action}`, { method: "POST", body: JSON.stringify(body) });
      if (requestVersion.current === version) setStatus(value); }
    catch (error) { if (requestVersion.current === version) { onError(error instanceof Error ? error.message : "Unable to update remote access."); await refresh(); } }
    finally { setBusy(false); }
  }
  return <section className="account-settings remote-access-settings">
    <h1>Remote access</h1>
    <p>View this computer’s tasks and send instructions from your signed-in OpenPond account. Tasks run on this computer.</p>
    <div className="account-summary"><div className="account-summary-main"><div>
      <strong>This computer{status?.device?.name ? ` · ${status.device.name}` : ""}</strong>
      <small role="status">{status ? status.state === "signed_out" ? "Sign in to connect" : status.enabled ? status.state.replaceAll("_", " ") : "Off" : "Checking connection…"}</small>
    </div></div><div className="account-summary-actions">
      <button type="button" disabled={busy || !status} onClick={() => void act(status?.enabled ? "disable" : "enable")}>
        {busy ? "Updating…" : status?.enabled ? "Turn off" : "Turn on"}
      </button><button type="button" disabled={busy} onClick={() => void refresh()}>Retry</button>
    </div></div>
    <p>Remote access stays off after restart and sign-in until you turn it on here. Sleeping or closing the app makes this computer unavailable.</p>
    <h2>Your computers</h2>
    {status?.devices.length === 0 && <p>No computers are enrolled.</p>}
    {status?.devices.map(device => <DeviceRow key={device.id} device={device} self={device.id === status.device?.id}
      busy={busy} act={act} />)}
    {!!status?.unresolvedTasks.length && <><h2>Choose ownership for older tasks</h2>
      <p>These tasks have no recorded account owner. Only add tasks that belong to you. Their local history is preserved.</p>
      {status.unresolvedTasks.map(task => <div className="account-summary" key={task.id}><strong>{task.title}</strong>
        <button type="button" disabled={busy} onClick={() => void act("attach", { sessionId: task.id, expectedRevision: task.revision })}>Add to my account</button>
      </div>)}</>}
  </section>;
}

function DeviceRow({ device, self, busy, act }: { device: RemoteDevice; self: boolean; busy: boolean;
  act(action: string, body: Record<string, unknown>): Promise<void> }) {
  const [name, setName] = useState(device.name);
  useEffect(() => setName(device.name), [device.name]);
  return <div className="account-summary"><div><strong>{self ? "This computer" : device.name}</strong>
    <small>{device.status.replaceAll("_", " ")}{device.lastSeenAt ? ` · Last seen ${new Date(device.lastSeenAt).toLocaleString()}` : ""}</small>
    <label>Computer name <input value={name} maxLength={200} disabled={busy} onChange={event => setName(event.target.value)} /></label>
  </div><div className="account-summary-actions">
    <button type="button" disabled={busy || !name.trim() || name === device.name} onClick={() => void act("rename", { deviceId: device.id, revision: device.revision, name: name.trim() })}>Save name</button>
    <button type="button" disabled={busy} onClick={() => void act("remove", { deviceId: device.id, revision: device.revision })}>Remove</button>
  </div></div>;
}
