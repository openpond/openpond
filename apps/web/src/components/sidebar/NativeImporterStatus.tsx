import type { CollectorStatus } from "@openpond/evals/native-conversations";
import { CircleAlert, Check, Loader2 } from "../icons";

export type ImporterConnectionControl = "pause" | "resume" | "disconnect";
export type ImporterControl = "start" | "stop" | "sync" | "install";
const sourceNames: Record<string, string> = { codex: "Codex", claude_code: "Claude Code", opencode: "OpenCode", grok_build: "Grok Build", hermes: "Hermes", pi: "Pi", oh_my_pi: "Oh My Pi", openclaw: "OpenClaw" };

/** Read the independently supervised collector; never start collection in React. */
export function NativeImporterStatus({ status, busy, onControl, onConnectionControl, onReconnect }: { status: CollectorStatus; busy: boolean; onControl(command: ImporterControl): void; onConnectionControl(command: ImporterConnectionControl, connectionId: string): void; onReconnect(connectionId: string): void }) {
  const stopped = status.desiredState === "stopped";
  const label = stopped ? "Importer stopped" : status.running ? "Importer running" : "Importer offline";
  return <div className="sidebar-section native-importer-status">
    <strong>{label}</strong>
    {status.connections.map((connection) => {
      const progress = connection.backfill;
      const complete = progress.stage === "complete";
      const done = progress.admitted + progress.skipped;
      return <div key={connection.id} className="native-importer-connection">
        <span>{connection.error ? <CircleAlert size={12} /> : complete ? <Check size={12} /> : <Loader2 size={12} />}{sourceNames[connection.source] ?? connection.source}</span>
        <small>{connection.state === "paused" ? "Paused" : connection.state === "disconnected" ? "Disconnected" : complete ? status.running && !stopped ? "Watching for new conversations" : `${progress.admitted} conversations imported` : progress.stage === "discovering" ? "Finding conversations" : `${done} of ${progress.total} conversations processed`}</small>
        <small>{connection.admitted} tasks admitted{progress.skipped > 0 ? `, ${progress.skipped} conversations skipped` : ""}{progress.failed > 0 ? `, ${progress.failed} failed` : ""}</small>
        {!complete && progress.total > 0 ? <progress aria-label={`${sourceNames[connection.source] ?? connection.source} import progress`} value={done} max={progress.total} /> : null}
        {connection.queued > 0 ? <small>{connection.queued} updates waiting to upload ({new Intl.NumberFormat(undefined, { notation: "compact" }).format(connection.pendingBytes)} bytes)</small> : null}
        {connection.lastAdmissionAt ? <small>Last synced <time dateTime={connection.lastAdmissionAt}>{new Date(connection.lastAdmissionAt).toLocaleString()}</time></small> : <small>No uploads acknowledged yet</small>}
        {connection.error ? <small role="status">{connection.error}</small> : null}
        {connection.state === "disconnected" ? <button type="button" disabled={busy} onClick={() => onReconnect(connection.id)}>Reconnect source</button> : <div>
          <button type="button" disabled={busy} onClick={() => onConnectionControl(connection.state === "paused" ? "resume" : "pause", connection.id)}>{connection.state === "paused" ? "Resume" : "Pause"} {sourceNames[connection.source] ?? connection.source}</button>
          <button type="button" disabled={busy} onClick={() => onConnectionControl("disconnect", connection.id)}>Disconnect {sourceNames[connection.source] ?? connection.source}</button>
        </div>}
      </div>;
    })}
    <button type="button" disabled={busy || stopped} onClick={() => onControl("sync")}>Sync now</button>
    <button type="button" disabled={busy} onClick={() => onControl(stopped || !status.running ? "start" : "stop")}>{stopped ? "Start" : status.running ? "Stop" : "Restart"} importer</button>
    {!status.running && !stopped ? <button type="button" disabled={busy} onClick={() => onControl("stop")}>Stop importer</button> : null}
    {!status.running && !stopped ? <button type="button" disabled={busy} onClick={() => onControl("install")}>Reinstall background service</button> : null}
  </div>;
}
