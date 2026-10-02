import type { CollectorStatus } from "@openpond/evals/native-conversations";
import { CircleAlert, Check, Loader2 } from "../icons";

export type ImporterControl = "start" | "stop" | "sync" | "install";
const sourceNames: Record<string, string> = { codex: "Codex", claude_code: "Claude Code", opencode: "OpenCode", grok_build: "Grok Build", hermes: "Hermes", pi: "Pi", oh_my_pi: "Oh My Pi", openclaw: "OpenClaw" };

/** Read the independently supervised collector; never start collection in React. */
export function NativeImporterStatus({ status, busy, onControl }: { status: CollectorStatus; busy: boolean; onControl(command: ImporterControl): void }) {
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
        <small>{connection.state === "paused" ? "Paused" : connection.state === "disconnected" ? "Disconnected" : complete ? `${progress.admitted} conversations imported` : progress.stage === "discovering" ? "Finding conversations" : `${done} of ${progress.total} conversations processed`}</small>
        {!complete && progress.total > 0 ? <progress aria-label={`${sourceNames[connection.source] ?? connection.source} import progress`} value={done} max={progress.total} /> : null}
        {connection.queued > 0 ? <small>{connection.queued} updates waiting to upload</small> : null}
        {connection.error ? <small role="status">{connection.error}</small> : null}
      </div>;
    })}
    <button type="button" disabled={busy || stopped} onClick={() => onControl("sync")}>Sync now</button>
    <button type="button" disabled={busy} onClick={() => onControl(stopped ? "start" : "stop")}>{stopped ? "Start" : "Stop"} importer</button>
    {!status.running && !stopped ? <button type="button" disabled={busy} onClick={() => onControl("install")}>Repair background service</button> : null}
  </div>;
}
