import { useState } from "react";
import type { CollectorStatus, CollectorSchedule } from "@openpond/evals/native-conversations";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { useAgentInventory } from "../apps/useAgentInventory";
import { AGENT_SOURCES, collectionState } from "../apps/agent-connections";
import { ConversationImportSchedule } from "./ConversationImportSchedule";
import { NativeSetupTerminal } from "../terminal/NativeSetupTerminal";
import { navigateDesktopRoute } from "../labs/lab-primary-tab-state";
import "../../styles/settings/conversation-imports.css";

type ImportConnection = CollectorStatus["connections"][number];
const dateTime = (value: string | null, timeZone: string) => value ? new Date(value).toLocaleString(undefined, { timeZone }) : "Not yet";

export function ConversationImportsSettings({ connection }: { connection: ClientConnection | null }) {
  const { inventory, loading, error, refresh } = useAgentInventory(connection);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  async function action(command: string, connectionId?: string, schedule?: CollectorSchedule | null) {
    if (!connection || busy) return;
    setBusy(true); setActionError(null);
    try {
      const result = await apiFetch<{ command?: string }>(connection, "/v1/native-history/collector", {
        method: "POST", body: JSON.stringify({ command, connectionId, ...(schedule !== undefined ? { schedule } : {}) }),
      });
      if (result.command) setCommand(result.command);
      await refresh();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "Unable to update conversation imports.");
      throw failure;
    } finally { setBusy(false); }
  }
  const perform = (command: string, id?: string) => { void action(command, id).catch(() => {}); };
  return <section className="account-settings conversation-imports">
    <div className="conversation-imports-heading"><div>
      <h1>Conversation imports</h1>
      <p>Import saved conversations once, or choose a separate recurring schedule for each source.</p>
    </div><button className="settings-secondary" type="button" disabled={loading} onClick={() => void refresh()}>Refresh</button></div>
    <p>Continual imports use this computer’s local time{inventory ? ` (${inventory.collector.timezone})` : ""}. If it is off or asleep, that run is skipped. The next scheduled run picks up changes from missed days.</p>
    <p>Imports do not enable continual learning or change model training schedules.</p>
    {error || actionError ? <p role="alert">{actionError ?? error}</p> : null}
    {!connection ? <p>Connect to a desktop runtime to manage imports.</p> : null}
    {loading && !inventory ? <p role="status">Loading conversation imports…</p> : null}
    {inventory ? <>
      <div className="conversation-imports-toolbar">
        <strong role="status">{inventory.collector.running ? "Import in progress" : "No import running"}</strong>
        {inventory.collector.running ? <button className="settings-secondary" type="button" disabled={busy} onClick={() => perform("stop")}>Cancel current run</button> : null}
      </div>
      {!inventory.collector.connections.length ? <div className="conversation-imports-empty">
        <p>No conversation sources connected. Choose a source in Connections and import its recent history.</p>
        <button className="settings-secondary" type="button" onClick={() => navigateDesktopRoute({ kind: "view", view: "apps" })}>Open Connections</button>
      </div> : inventory.collector.connections.map(item => <ImportCard key={item.id} item={item} status={inventory.collector}
        disabled={busy || command !== null} onAction={perform}
        onSchedule={schedule => action("schedule", item.id, schedule)} />)}
      <details><summary>CLI and local state</summary><p>{inventory.directory}</p><code>{inventory.statusCommand}</code></details>
    </> : null}
    {command && connection ? <NativeSetupTerminal connection={connection} command={command}
      onComplete={() => void refresh()} onClose={() => { setCommand(null); void refresh(); }} /> : null}
  </section>;
}

function ImportCard({ item, status, disabled, onAction, onSchedule }: {
  item: ImportConnection; status: CollectorStatus; disabled: boolean;
  onAction(command: string, id?: string): void; onSchedule(schedule: CollectorSchedule | null): Promise<void>;
}) {
  const source = AGENT_SOURCES.find(source => source.id === item.source);
  const run = item.run;
  const running = status.running && run?.state === "running";
  return <article className="conversation-import-card">
    <div className="conversation-import-card-heading"><h3>{source?.name ?? item.source}</h3><span>{collectionState(item, status)}</span></div>
    <dl className="conversation-import-details">
      <div><dt>Destination</dt><dd>{item.accountBaseUrl ?? "Hosted destination"}</dd></div>
      <div><dt>Project</dt><dd>{item.projectId}</dd></div>
      <div><dt>Source</dt><dd>{item.sourceRoot}</dd></div>
      <div><dt>Initial history</dt><dd>{item.since ? `Since ${dateTime(item.since, status.timezone)}` : "All history"}</dd></div>
      <div><dt>Last successful sync</dt><dd>{dateTime(item.lastSuccessfulSyncAt, status.timezone)}</dd></div>
      <div><dt>Next sync</dt><dd>{item.nextRunAt ? dateTime(item.nextRunAt, status.timezone) : item.schedule ? "Source paused or disconnected" : "Manual only"}</dd></div>
    </dl>
    {running && run ? <div role="status" className="conversation-import-progress">
      <span>{run.phase === "uploading" ? "Uploading conversations" : run.phase === "discovering" ? "Finding conversations" : "Reading conversations"} · {run.processed} of {run.discovered} checked</span>
      {run.discovered > 0 ? <progress value={run.processed} max={run.discovered} aria-label={`${source?.name ?? item.source} import progress`} /> : <progress aria-label="Finding conversations" />}
      <small>{run.uploaded} turns uploaded · {item.queued} updates queued</small>
    </div> : <p>{item.admitted} turns imported · {item.queued} updates queued{run?.state === "cancelled" ? " · Last run cancelled" : ""}</p>}
    {item.error || run?.state === "failed" ? <p role="alert">{item.error ?? run?.error}</p> : null}
    <ConversationImportSchedule schedule={item.schedule} name={source?.name ?? item.source} disabled={disabled}
      disconnected={item.state === "disconnected"} onSave={onSchedule} />
    <div className="settings-button-row">
      <button className="settings-secondary" type="button" disabled={disabled || status.running || item.state !== "active"} onClick={() => onAction("sync", item.id)}>Sync now</button>
      {item.state === "disconnected" ? <button className="settings-secondary" type="button" disabled={disabled} onClick={() => onAction("reconnect", item.id)}>Reconnect</button> : <>
        <button className="settings-secondary" type="button" disabled={disabled} onClick={() => onAction(item.state === "paused" ? "resume" : "pause", item.id)}>{item.state === "paused" ? "Resume source" : "Pause source"}</button>
        <button className="settings-secondary" type="button" disabled={disabled} onClick={() => onAction("disconnect", item.id)}>Disconnect</button>
      </>}
    </div>
  </article>;
}
