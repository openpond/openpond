import { NativeSetupTerminal } from "../terminal/NativeSetupTerminal";
import { useCallback, useEffect, useState } from "react";
import type { Session } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { RefreshCw, Loader2, CircleAlert } from "../icons";
import type { CollectorStatus, NativeBranchChoice, NativeBranchInspection } from "@openpond/evals/native-conversations";
import { NativeImporterStatus, type ImporterControl, type ImporterConnectionControl } from "./NativeImporterStatus";
import { NativeBranchPicker } from "./NativeBranchPicker";

type HistoryPayload = {
  items: Array<{ id: string; source: string; title: string; cwd: string | null; updatedAt: string }>;
  nextCursors: Record<string, string>;
  warnings: string[];
  collector: CollectorStatus;
};
export function NativeConversationSources({ connection, selectedSessionId, onOpen }: { connection: ClientConnection | null; selectedSessionId: string | null; onOpen(session: Session): void }) {
  const [following, setFollowing] = useState<{ id: string; sessionId: string } | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [branchSelection, setBranchSelection] = useState<{ id: string; inspection: NativeBranchInspection } | null>(null);
  const refresh = useCallback(async () => {
    if (!connection) return;
    setBusy("refresh");
    try { setHistory(await apiFetch<HistoryPayload>(connection, "/v1/native-history/list", { method: "POST", body: "{}" })); setError(null); }
    catch (error) { setError(error instanceof Error ? error.message : "Local history is unavailable."); }
    finally { setBusy(null); }
  }, [connection]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!expanded) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [expanded, refresh]);
  useEffect(() => {
    if (!connection || !following || following.sessionId !== selectedSessionId) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void apiFetch(connection, "/v1/native-history/open", { method: "POST", body: JSON.stringify({ id: following.id }) }).catch((error: Error) => setError(error.message));
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [connection, following, selectedSessionId]);
  async function more() {
    if (!connection || !history) return;
    setBusy("more");
    try {
      const next = await apiFetch<HistoryPayload>(connection, "/v1/native-history/list", { method: "POST", body: JSON.stringify({ cursors: history.nextCursors }) });
      setHistory((previous) => ({ ...next, items: [...new Map([...(previous?.items ?? []), ...next.items].map((item) => [item.id, item])).values()] }));
    } catch (error) { setError(error instanceof Error ? error.message : "Could not load more conversations."); }
    finally { setBusy(null); }
  }
  async function open(id: string, branch?: NativeBranchChoice) {
    if (!connection) return;
    setBusy(id);
    try {
      if (!branch) {
        const inspection = await apiFetch<NativeBranchInspection>(connection, "/v1/native-history/branches", { method: "POST", body: JSON.stringify({ id }) });
        if (inspection.branches.length > 1) { setBranchSelection({ id, inspection }); setError(null); return; }
      }
      const session = await apiFetch<Session>(connection, "/v1/native-history/open", { method: "POST", body: JSON.stringify({ id, branch }) });
      setFollowing(branch ? null : { id, sessionId: session.id }); setBranchSelection(null);
      setError(session.metadata?.nativeHistoryProjection && !session.nativeAgent ? typeof session.metadata.nativeReadOnlyReason === "string" ? session.metadata.nativeReadOnlyReason : "Read-only history: the native source does not report its original working directory." : null); onOpen(session);
    }
    catch (error) { setError(error instanceof Error ? error.message : "Could not read this conversation."); }
    finally { setBusy(null); }
  }
  async function control(command: ImporterControl) {
    if (!connection) return;
    setBusy(command);
    try { await apiFetch(connection, "/v1/native-history/collector", { method: "POST", body: JSON.stringify({ command }) }); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : "Collector action failed."); }
    finally { setBusy(null); }
  }
  async function connectionControl(action: ImporterConnectionControl, connectionId: string) {
    if (!connection) return;
    setBusy(action);
    try {
      const result = await apiFetch<{ command: string }>(connection, "/v1/native-history/collector", { method: "POST", body: JSON.stringify({ command: action, connectionId }) });
      setCommand(result.command); setError(null);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not change Importer connection."); }
    finally { setBusy(null); }
  }
  async function connect(connectionId?: string) {
    if (!connection) return;
    setBusy("connect");
    try {
      const result = await apiFetch<{ command: string }>(connection, "/v1/native-history/collector", { method: "POST", body: JSON.stringify({ command: connectionId ? "reconnect" : "connect", connectionId }) });
      setCommand(result.command); setError(null);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not open Importer setup."); }
    finally { setBusy(null); }
  }
  if (!connection) return null;
  return <section className="sidebar-section native-conversations" aria-label="Local agent conversations">
    <div className="sidebar-section-heading"><button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>Local agents{history ? ` (${history.items.length})` : ""}</button><button type="button" className="sidebar-icon" aria-label="Refresh local agents" disabled={busy !== null} onClick={() => void refresh()}>{busy === "refresh" ? <Loader2 size={14} /> : <RefreshCw size={14} />}</button></div>
    {command ? <NativeSetupTerminal connection={connection} command={command} onClose={() => { setCommand(null); void refresh(); }} /> : null}
    {expanded ? <>
      <button type="button" disabled={busy !== null} onClick={() => void connect()}>Import conversations</button>
      {branchSelection ? <NativeBranchPicker title={history?.items.find(item => item.id === branchSelection.id)?.title ?? ""} inspection={branchSelection.inspection} busy={busy !== null} onSelect={branch => void open(branchSelection.id, branch)} onRefresh={() => void open(branchSelection.id)} onClose={() => setBranchSelection(null)} /> : null}
      {history?.items.map((item) => <button type="button" key={item.id} className="sidebar-row sidebar-task-row native-conversation-row" disabled={busy !== null} title={`${item.source}\n${item.cwd ?? "Working directory unavailable"}\n${item.updatedAt}`} onClick={() => void open(item.id)}><span>{item.title || "Untitled conversation"}</span><small>{item.source}{!item.cwd ? " (read-only)" : ""}</small></button>)}
      {history && Object.keys(history.nextCursors).length ? <button type="button" disabled={busy !== null} onClick={() => void more()}>Load more conversations</button> : null}
      {history && history.items.length === 0 ? <p>No saved conversations found in configured source locations.</p> : null}
      {history?.warnings.map((warning) => <p key={warning}><CircleAlert size={12} aria-hidden="true" /> {warning}</p>)}
      {history?.collector.connections.length ? <NativeImporterStatus status={history.collector} busy={busy !== null} onControl={(command) => void control(command)} onConnectionControl={(command, id) => void connectionControl(command, id)} onReconnect={(id) => void connect(id)} /> : <p>To upload these conversations, connect a source with the OpenPond Importer. Local history stays available without cloud sync.</p>}
    </> : null}
    {error ? <p role="status"><CircleAlert size={12} aria-hidden="true" /> {error}</p> : null}
  </section>;
}
