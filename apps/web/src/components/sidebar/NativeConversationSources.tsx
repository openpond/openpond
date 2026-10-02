import { NativeSetupTerminal } from "../terminal/NativeSetupTerminal";
import { useCallback, useEffect, useState } from "react";
import type { Session } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { RefreshCw, Loader2, CircleAlert } from "../icons";

type HistoryPayload = {
  items: Array<{ id: string; source: string; title: string; cwd: string | null; updatedAt: string }>;
  nextCursors: Record<string, string>;
  warnings: string[];
  collector: { running: boolean; desiredState: "running" | "stopped"; connections: Array<{ source: string; queued: number; admitted: number; error: string | null }> };
};
export function NativeConversationSources({ connection, selectedSessionId, onOpen }: { connection: ClientConnection | null; selectedSessionId: string | null; onOpen(session: Session): void }) {
  const [following, setFollowing] = useState<{ id: string; sessionId: string } | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
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
  async function open(id: string) {
    if (!connection) return;
    setBusy(id);
    try { const session = await apiFetch<Session>(connection, "/v1/native-history/open", { method: "POST", body: JSON.stringify({ id }) }); setFollowing({ id, sessionId: session.id }); onOpen(session); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not read this conversation."); }
    finally { setBusy(null); }
  }
  async function control(command: "start" | "stop" | "sync" | "install") {
    if (!connection) return;
    setBusy(command);
    try { await apiFetch(connection, "/v1/native-history/collector", { method: "POST", body: JSON.stringify({ command }) }); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : "Collector action failed."); }
    finally { setBusy(null); }
  }
  async function connect() {
    if (!connection) return;
    setBusy("connect");
    try {
      const result = await apiFetch<{ command: string }>(connection, "/v1/native-history/collector", { method: "POST", body: JSON.stringify({ command: "connect" }) });
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
      {history?.items.map((item) => <button type="button" key={item.id} className="sidebar-row sidebar-task-row native-conversation-row" disabled={busy !== null} title={`${item.source}\n${item.cwd ?? "Working directory unavailable"}\n${item.updatedAt}`} onClick={() => void open(item.id)}><span>{item.title || "Untitled conversation"}</span><small>{item.source}</small></button>)}
      {history && Object.keys(history.nextCursors).length ? <button type="button" disabled={busy !== null} onClick={() => void more()}>Load more conversations</button> : null}
      {history && history.items.length === 0 ? <p>No saved conversations found in configured source locations.</p> : null}
      {history?.warnings.map((warning) => <p key={warning}><CircleAlert size={12} aria-hidden="true" /> {warning}</p>)}
      {history?.collector.connections.length ? <div className="sidebar-section"><strong>{history.collector.running ? "Importer running" : history.collector.desiredState === "stopped" ? "Importer stopped" : "Importer offline"}</strong><button type="button" disabled={busy !== null} onClick={() => void control("sync")}>Sync now</button><button type="button" disabled={busy !== null} onClick={() => void control("install")}>Repair background service</button><button type="button" disabled={busy !== null} onClick={() => void control(history.collector.desiredState === "stopped" ? "start" : "stop")}>{history.collector.desiredState === "stopped" ? "Start" : "Stop"} importer</button></div> : <p>To upload these conversations, connect a source with the OpenPond Importer. Local history stays available without cloud sync.</p>}
    </> : null}
    {error ? <p role="status"><CircleAlert size={12} aria-hidden="true" /> {error}</p> : null}
  </section>;
}
